/**
 * Sync Service — push robot logs back to AllAboutHack
 * Uses POST /api/sessions/{session}/robot-logs on AllAboutHack
 */
const axios = require('axios');
const { getDb } = require('../db');

class SyncService {
    /**
     * Sync unsynced robot_logs to AllAboutHack
     * Returns { synced: number, total: number }
     */
    async syncLogs() {
        const db = getDb();
        const config = db.prepare('SELECT * FROM session_config WHERE id = 1').get();

        if (!config || !config.allabouthack_url || !config.competition_session_id) {
            console.log('Sync: No AllAboutHack URL or session ID configured');
            return { synced: 0, total: 0, reason: 'not_configured' };
        }

        const lastSyncId = config.last_log_sync_id || 0;
        const logs = db.prepare('SELECT * FROM robot_logs WHERE id > ? ORDER BY id ASC LIMIT 200')
            .all(lastSyncId);

        if (logs.length === 0) {
            return { synced: 0, total: 0, reason: 'no_new_logs' };
        }

        const payload = {
            logs: logs.map(l => ({
                event_type: l.event_type,
                event_timestamp: l.created_at,
                data: l.data ? JSON.parse(l.data) : {}
            }))
        };

        const url = `${config.allabouthack_url.replace(/\/$/, '')}/api/sessions/${config.competition_session_id}/robot-logs`;

        const response = await axios.post(url, payload, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.status >= 200 && response.status < 300) {
            const maxId = logs[logs.length - 1].id;
            db.prepare('UPDATE session_config SET last_log_sync_id = ?, updated_at = datetime(\'now\') WHERE id = 1')
                .run(maxId);
            console.log(`📤 Synced ${logs.length} logs to AllAboutHack (up to id ${maxId})`);
            return { synced: logs.length, total: logs.length, lastId: maxId };
        }

        throw new Error(`AllAboutHack responded with ${response.status}`);
    }
}

module.exports = new SyncService();
