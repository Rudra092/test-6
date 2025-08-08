require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // node 18+ has global fetch; included for compatibility
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving'; // public OSRM demo

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

// basic health
app.get('/', (req, res) => res.json({ ok: true }));

// route proxy: /route?start=lon,lat&end=lon,lat
app.get('/route', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required as "lon,lat"' });

    // OSRM expects coordinates as lon,lat; we already accept that format
    // Request: GET /route/v1/driving/{start};{end}?overview=full&geometries=geojson&alternatives=false&steps=false
    const url = `${OSRM_BASE}/${start};${end}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'Routing service error' });

    const j = await r.json();
    if (!j.routes || !j.routes.length) return res.status(404).json({ error: 'No route found' });

    const route = j.routes[0];
    return res.json({
      distance_meters: route.distance,
      duration_seconds: route.duration,
      geometry: route.geometry // GeoJSON LineString
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
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
