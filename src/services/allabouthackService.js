/**
 * AllAboutHack Streaming Service
 * Forwards robot logs (RFID scans, movement, order events) in real-time via HTTP POST
 * Replaces the old batch syncService
 */
const axios = require('axios');
const { getDb } = require('../db');

class AllAboutHackService {
    constructor() {
        this._queue = [];
        this._flushing = false;
        this._flushTimer = null;
    }

    _getConfig() {
        const db = getDb();
        return db.prepare('SELECT * FROM session_config WHERE id = 1').get();
    }

    _isReady() {
        const config = this._getConfig();
        return config && config.allabouthack_url && config.competition_session_id && config.status === 'running';
    }

    /**
     * Queue a log event to be sent to AllAboutHack
     * @param {string} eventType - e.g. 'rfid_scan', 'vehicle_position', 'order_status', 'navigation_log'
     * @param {object} data - event payload
     */
    send(eventType, data) {
        if (!this._isReady()) return;

        this._queue.push({
            event_type: eventType,
            event_timestamp: new Date().toISOString(),
            data
        });

        // Debounce flush — send within 500ms or when queue hits 10
        if (this._queue.length >= 10) {
            this._flush();
        } else if (!this._flushTimer) {
            this._flushTimer = setTimeout(() => this._flush(), 500);
        }
    }

    async _flush() {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        if (this._flushing || this._queue.length === 0) return;

        this._flushing = true;
        const batch = this._queue.splice(0, 50);
        const config = this._getConfig();

        if (!config || !config.allabouthack_url || !config.competition_session_id) {
            this._flushing = false;
            return;
        }

        const url = `${config.allabouthack_url.replace(/\/$/, '')}/api/sessions/${config.competition_session_id}/robot-logs`;

        try {
            await axios.post(url, { logs: batch }, {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (err) {
            console.error('AllAboutHack log push failed:', err.message);
            // Re-queue failed items (at front) up to a limit
            if (this._queue.length < 200) {
                this._queue.unshift(...batch);
            }
        }

        this._flushing = false;

        // If more in queue, flush again
        if (this._queue.length > 0) {
            this._flushTimer = setTimeout(() => this._flush(), 500);
        }
    }

    /**
     * Force flush all queued logs (called on session end)
     */
    async flushAll() {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        while (this._queue.length > 0) {
            await this._flush();
        }
    }
}

module.exports = new AllAboutHackService();
