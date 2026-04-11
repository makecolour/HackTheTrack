const express = require('express');
const vehicleService = require('../services/vehicleService');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// GET /api/vehicle/status
router.get('/status', (_req, res) => {
    res.json({ success: true, data: vehicleService.getStatus() });
});

// PUT /api/vehicle/position
router.put('/position', authenticate, authorize('staff'), (req, res) => {
    const { pointId, positionType } = req.body;
    const vehicle = vehicleService.updatePosition(pointId, positionType || 'manual');
    const io = req.app.get('io');
    if (io) io.emit('vehicle-position', { pointId, positionType: positionType || 'manual' });
    res.json({ success: true, data: vehicle });
});

// POST /api/vehicle/reset
router.post('/reset', authenticate, authorize('staff'), (_req, res) => {
    vehicleService.reset();
    const io = _req.app.get('io');
    if (io) io.emit('vehicle-returned', { message: 'Vehicle reset' });
    res.json({ success: true, message: 'Vehicle reset to start' });
});

module.exports = router;
