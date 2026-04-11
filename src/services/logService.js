/**
 * Robot Activity Log Service
 */
const { getDb } = require('../db');

class LogService {
    log(eventType, data, sessionId) {
        const db = getDb();
        db.prepare('INSERT INTO robot_logs (event_type, data, session_id) VALUES (?, ?, ?)')
            .run(eventType, JSON.stringify(data), sessionId || null);
    }

    getAll(limit = 100, offset = 0) {
        const db = getDb();
        return db.prepare('SELECT * FROM robot_logs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    }

    getBySession(sessionId) {
        const db = getDb();
        return db.prepare('SELECT * FROM robot_logs WHERE session_id = ? ORDER BY created_at ASC').all(sessionId);
    }

    getByTimeRange(from, to) {
        const db = getDb();
        return db.prepare('SELECT * FROM robot_logs WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC').all(from, to);
    }
}

module.exports = new LogService();
