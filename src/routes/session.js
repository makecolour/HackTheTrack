const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/session — get current session config
router.get('/', (_req, res) => {
    const db = getDb();
    const session = db.prepare('SELECT * FROM session_config WHERE id = 1').get();
    res.json({ success: true, data: session });
});

// POST /api/session/configure — AllAboutHack pushes session config
router.post('/configure', (req, res) => {
    const {
        // AllAboutHack sends snake_case
        session_id, team_id, team_code, phase, attempt_number,
        run_time_seconds, target_point_a, target_point_b,
        waypoints, connections_meta, allabouthack_url,
        // Also accept camelCase for direct calls
        competitionSessionId, targetPointA, targetPointB, runTimeSeconds
    } = req.body;

    const db = getDb();
    const sessId = session_id || competitionSessionId;
    const ptA = target_point_a || targetPointA;
    const ptB = target_point_b || targetPointB;
    const runTime = run_time_seconds || runTimeSeconds;

    db.prepare(`
        UPDATE session_config SET
            competition_session_id = ?,
            target_point_a = ?,
            target_point_b = ?,
            run_time_seconds = ?,
            allabouthack_url = ?,
            team_code = ?,
            phase = ?,
            attempt_number = ?,
            last_log_sync_id = 0,
            status = 'configured',
            updated_at = datetime('now')
        WHERE id = 1
    `).run(sessId, ptA || null, ptB || null, runTime || null,
           allabouthack_url || null, team_code || null, phase || null, attempt_number || null);

    // Sync map points from AllAboutHack waypoints
    if (Array.isArray(waypoints) && waypoints.length > 0) {
        syncMapFromWaypoints(db, waypoints);
    }

    const io = req.app.get('io');
    if (io) io.emit('session-configured', {
        competitionSessionId: sessId, targetPointA: ptA, targetPointB: ptB,
        runTimeSeconds: runTime, teamCode: team_code, phase
    });

    res.json({ success: true, message: 'Session configured' });
});

/**
 * Sync map_points table from AllAboutHack CourseMap waypoints
 * Waypoint format: { point_id, x, y, label, type, connections: [...], rfid_tag_id }
 */
function syncMapFromWaypoints(db, waypoints) {
    const syncTx = db.transaction(() => {
        db.prepare('DELETE FROM map_points').run();
        db.prepare('DELETE FROM rfid_tags').run();

        const insPoint = db.prepare(`INSERT OR REPLACE INTO map_points (point_id, x, y, label, type, connections, rfid_tag_id)
                                     VALUES (?, ?, ?, ?, ?, ?, ?)`);
        const insRfid = db.prepare('INSERT OR REPLACE INTO rfid_tags (rfid_id, name, x, y) VALUES (?, ?, ?, ?)');

        for (const wp of waypoints) {
            const pointId = wp.point_id || wp.pointId;
            const conns = Array.isArray(wp.connections) ? JSON.stringify(wp.connections)
                        : (typeof wp.connections === 'string' ? wp.connections : '[]');
            const rfid = wp.rfid_tag_id || wp.rfidTagId || null;
            const type = wp.type || 'waypoint';
            insPoint.run(pointId, wp.x, wp.y, wp.label || pointId, type, conns, rfid);
            if (rfid) {
                insRfid.run(rfid, wp.label || pointId, wp.x, wp.y);
            }
        }
    });
    syncTx();
    console.log(`🗺️  Map synced: ${waypoints.length} points from AllAboutHack`);
}

// POST /api/session/start — begin the run
router.post('/start', (req, res) => {
    const db = getDb();
    db.prepare("UPDATE session_config SET status = 'running', started_at = datetime('now'), updated_at = datetime('now') WHERE id = 1").run();
    const io = req.app.get('io');
    if (io) io.emit('session-started');
    res.json({ success: true, message: 'Session started' });
});

// POST /api/session/end — end the run, trigger log sync
router.post('/end', async (req, res) => {
    const db = getDb();
    db.prepare("UPDATE session_config SET status = 'ended', updated_at = datetime('now') WHERE id = 1").run();
    const io = req.app.get('io');
    if (io) io.emit('session-ended');

    // Sync logs back to AllAboutHack
    const syncService = require('../services/syncService');
    syncService.syncLogs().catch(err => console.error('Log sync failed:', err.message));

    res.json({ success: true, message: 'Session ended' });
});

// POST /api/session/reset
router.post('/reset', (req, res) => {
    const db = getDb();
    db.prepare("UPDATE session_config SET status = 'idle', competition_session_id = NULL, target_point_a = NULL, target_point_b = NULL, run_time_seconds = NULL, allabouthack_url = NULL, team_code = NULL, phase = NULL, attempt_number = NULL, last_log_sync_id = 0, started_at = NULL, updated_at = datetime('now') WHERE id = 1").run();
    const io = req.app.get('io');
    if (io) io.emit('session-reset');
    res.json({ success: true, message: 'Session reset' });
});

// POST /api/session/sync-logs — manual log sync trigger
router.post('/sync-logs', async (req, res) => {
    const syncService = require('../services/syncService');
    try {
        const result = await syncService.syncLogs();
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
