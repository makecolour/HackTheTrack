const express = require('express');
const axios = require('axios');

const router = express.Router();
const HARDWARE_URL = process.env.HARDWARE_URL || 'http://localhost:8765';

// GET /api/hardware/status — proxy to hardware daemon
router.get('/status', async (_req, res) => {
    try {
        const resp = await axios.get(`${HARDWARE_URL}/hardware/status`, { timeout: 3000 });
        res.json({ success: true, data: resp.data });
    } catch {
        res.json({ success: true, data: { status: 'disconnected' } });
    }
});

// POST /api/hardware/motor — send motor command
router.post('/motor', (req, res) => {
    const { command, speed } = req.body;
    const io = req.app.get('io');
    if (io) io.to('hardware').emit('motor-command', { command, speed });
    res.json({ success: true, message: `Motor: ${command}` });
});

// GET /api/hardware/camera/status
router.get('/camera/status', async (_req, res) => {
    try {
        const resp = await axios.get(`${HARDWARE_URL}/camera/status`, { timeout: 3000 });
        res.json({ success: true, data: resp.data });
    } catch {
        res.json({ success: true, data: { status: 'disconnected' } });
    }
});

module.exports = router;
