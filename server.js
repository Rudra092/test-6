require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // node 18+ has global fetch; included for compatibility
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving'; // public OSRM demo
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search'; // Geocoding service

// MongoDB optional
let routesCollection = null;
if (process.env.MONGODB_URI) {
  (async () => {
    try {
      const client = new MongoClient(process.env.MONGODB_URI);
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'easymap');
      routesCollection = db.collection('routes');
      console.log('Connected to MongoDB');
    } catch (err) {
      console.error('MongoDB connect error', err);
    }
  })();
}

// Geocoding function to convert place name to coordinates
async function geocodePlace(placeName) {
  try {
    const url = `${NOMINATIM_BASE}?q=${encodeURIComponent(placeName)}&format=json&limit=1&addressdetails=1`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'EasyMap/1.0'
      }
    });
    
    if (!response.ok) throw new Error('Geocoding service error');
    
    const results = await response.json();
    if (!results || results.length === 0) {
      throw new Error(`No location found for "${placeName}"`);
    }
    
    const result = results[0];
    return {
      lat: parseFloat(result.lat),
      lon: parseFloat(result.lon),
      display_name: result.display_name
    };
  } catch (error) {
    throw new Error(`Geocoding failed for "${placeName}": ${error.message}`);
  }
}

// Helper function to determine if input is coordinates or place name
function isCoordinates(input) {
  const coordPattern = /^-?\d+\.?\d*,-?\d+\.?\d*$/;
  return coordPattern.test(input.trim());
}

// Parse coordinates from string like "12.34,56.78"
function parseCoordinates(coordStr) {
  const parts = coordStr.split(',').map(p => parseFloat(p.trim()));
  if (parts.length !== 2 || !parts.every(p => Number.isFinite(p))) {
    throw new Error('Invalid coordinate format');
  }
  return { lat: parts[0], lon: parts[1] };
}

// basic health
app.get('/', (req, res) => res.json({ ok: true }));

// Geocoding endpoint
app.get('/geocode', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });
    
    const result = await geocodePlace(q);
    res.json(result);
  } catch (err) {
    console.error('Geocoding error:', err);
    res.status(400).json({ error: err.message });
  }
});

// route proxy: /route?start=place_or_coords&end=place_or_coords
app.get('/route', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    let startCoords, endCoords;

    // Process start location
    if (isCoordinates(start)) {
      const coords = parseCoordinates(start);
      startCoords = `${coords.lon},${coords.lat}`;
    } else {
      const geocoded = await geocodePlace(start);
      startCoords = `${geocoded.lon},${geocoded.lat}`;
    }

    // Process end location
    if (isCoordinates(end)) {
      const coords = parseCoordinates(end);
      endCoords = `${coords.lon},${coords.lat}`;
    } else {
      const geocoded = await geocodePlace(end);
      endCoords = `${geocoded.lon},${geocoded.lat}`;
    }

    // Request route from OSRM
    const url = `${OSRM_BASE}/${startCoords};${endCoords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'Routing service error' });

    const j = await r.json();
    if (!j.routes || !j.routes.length) return res.status(404).json({ error: 'No route found' });

    const route = j.routes[0];
    return res.json({
      distance_meters: route.distance,
      duration_seconds: route.duration,
      geometry: route.geometry, // GeoJSON LineString
      start_coords: startCoords,
      end_coords: endCoords
    });
  } catch (err) {
    console.error('Routing error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// save a route to MongoDB (optional)
app.post('/save-route', async (req, res) => {
  if (!routesCollection) return res.status(400).json({ error: 'MongoDB not configured' });
  const { name, geo } = req.body;
  if (!geo) return res.status(400).json({ error: 'geo required' });
  try {
    const doc = { name: name || 'Unnamed', geo, createdAt: new Date() };
    const r = await routesCollection.insertOne(doc);
    res.json({ ok: true, id: r.insertedId, message: 'Saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Save failed' });
  }
});

// list saved routes
app.get('/routes', async (req, res) => {
  if (!routesCollection) return res.json([]);
  const list = await routesCollection.find({}).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(list);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, ()=> console.log('Server listening on', PORT));