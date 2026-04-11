const express = require('express');
const logService = require('../services/logService');

const router = express.Router();

// GET /api/robot-logs
router.get('/', (req, res) => {
    const { limit, offset, sessionId, from, to } = req.query;
    let logs;
    if (sessionId) {
        logs = logService.getBySession(sessionId);
    } else if (from && to) {
        logs = logService.getByTimeRange(from, to);
    } else {
        logs = logService.getAll(Number(limit) || 100, Number(offset) || 0);
    }
    res.json({ success: true, data: logs });
});

module.exports = router;
