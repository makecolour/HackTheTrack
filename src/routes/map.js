const express = require('express');
const { getDb } = require('../db');
const mapService = require('../services/mapService');

const router = express.Router();

// GET /api/map/points — all map points
router.get('/points', (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM map_points').all();
    const points = rows.map(r => ({
        pointId: r.point_id, x: r.x, y: r.y, label: r.label,
        type: r.type, connections: JSON.parse(r.connections), rfidTagId: r.rfid_tag_id
    }));
    res.json({ success: true, data: points });
});

// GET /api/map/destinations — destination-type points
router.get('/destinations', (_req, res) => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM map_points WHERE type = 'destination'").all();
    const points = rows.map(r => ({
        pointId: r.point_id, x: r.x, y: r.y, label: r.label,
        type: r.type, connections: JSON.parse(r.connections), rfidTagId: r.rfid_tag_id
    }));
    res.json({ success: true, data: points });
});

// GET /api/map/path?from=X&to=Y&via=Z — Dijkstra pathfinding
router.get('/path', (req, res) => {
    const { from, to, via } = req.query;
    if (!from || !to) {
        return res.status(400).json({ success: false, message: 'from and to required' });
    }
    const path = via
        ? mapService.findConstrainedPath(from, via, to)
        : mapService.findPath(from, to);

    if (!path) {
        return res.status(404).json({ success: false, message: 'No path found' });
    }
    res.json({ success: true, data: path });
});

// POST /api/map/seed — reseed demo map
router.post('/seed', (_req, res) => {
    const { seedDemoMap } = require('../db');
    seedDemoMap();
    res.json({ success: true, message: 'Map reseeded' });
});

module.exports = router;
