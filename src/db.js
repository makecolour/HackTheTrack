/**
 * SQLite database initialization (better-sqlite3)
 * All tables created synchronously on startup.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db');

let _db = null;

function getDb() {
    if (!_db) {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        _db = new Database(DB_PATH);
        _db.pragma('journal_mode = WAL');
        _db.pragma('foreign_keys = ON');
    }
    return _db;
}

function initialize() {
    const db = getDb();

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('staff')),
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS map_points (
            point_id TEXT PRIMARY KEY,
            x REAL NOT NULL,
            y REAL NOT NULL,
            label TEXT,
            type TEXT NOT NULL CHECK(type IN ('start','destination','intersection','waypoint','stop','warehouse')),
            connections TEXT NOT NULL DEFAULT '[]',
            rfid_tag_id TEXT
        );

        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            destination_a TEXT NOT NULL,
            destination_b TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','accepted','delivering','arrived_a','arrived_b','delivered','returning','cancelled')),
            vehicle_status TEXT DEFAULT 'idle'
                CHECK(vehicle_status IN ('idle','moving','arrived')),
            note TEXT,
            session_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS vehicle (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            current_point TEXT,
            position_type TEXT DEFAULT 'unknown',
            heading_dx REAL,
            heading_dy REAL,
            status TEXT DEFAULT 'idle',
            delivery_order_id INTEGER,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS robot_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            data TEXT,
            session_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS rfid_tags (
            rfid_id TEXT PRIMARY KEY,
            name TEXT,
            x REAL,
            y REAL
        );

        CREATE TABLE IF NOT EXISTS session_config (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            competition_session_id INTEGER,
            target_point_a TEXT,
            target_point_b TEXT,
            run_time_seconds INTEGER,
            status TEXT DEFAULT 'idle',
            allabouthack_url TEXT,
            team_code TEXT,
            phase TEXT,
            attempt_number INTEGER,
            last_log_sync_id INTEGER DEFAULT 0,
            started_at TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );
    `);

    // Seed default vehicle row
    const vehicleRow = db.prepare('SELECT id FROM vehicle WHERE id = 1').get();
    if (!vehicleRow) {
        db.prepare('INSERT INTO vehicle (id, current_point, status) VALUES (1, ?, ?)').run('S', 'idle');
    }

    // Seed default session config
    const sessionRow = db.prepare('SELECT id FROM session_config WHERE id = 1').get();
    if (!sessionRow) {
        db.prepare('INSERT INTO session_config (id, status) VALUES (1, ?)').run('idle');
    }

    // Seed default users
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (userCount === 0) {
        const insert = db.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)');
        const hash = bcrypt.hashSync('1234', 10);
        insert.run('staff1', hash, 'Staff 01', 'staff');
        insert.run('staff2', hash, 'Staff 02', 'staff');
        console.log('👤 Default users seeded (password: 1234)');
    }

    // Seed demo map if empty
    const mapCount = db.prepare('SELECT COUNT(*) as c FROM map_points').get().c;
    if (mapCount === 0) {
        seedDemoMap(db);
        console.log('🗺️  Demo map seeded');
    }

    console.log('✅ Database initialized');
}

function seedDemoMap(database) {
    const db = database || getDb();
    db.prepare('DELETE FROM map_points').run();
    db.prepare('DELETE FROM rfid_tags').run();

    const points = [
        { pointId: 'TL', x: 50, y: 50, label: 'Góc trên trái', type: 'waypoint', connections: ['B', 'P1'], rfidTagId: 'RFID_TL' },
        { pointId: 'B', x: 300, y: 50, label: 'Điểm B', type: 'destination', connections: ['TL', 'S'], rfidTagId: 'RFID_B' },
        { pointId: 'S', x: 550, y: 50, label: 'Start (Xuất phát)', type: 'start', connections: ['B', 'P3'], rfidTagId: 'RFID_S' },

        { pointId: 'P1', x: 50, y: 235, label: 'Ngã tư trái', type: 'intersection', connections: ['TL', 'P2', 'A'], rfidTagId: 'RFID_P1' },
        { pointId: 'P2', x: 300, y: 235, label: 'Ngã tư trung tâm trên', type: 'intersection', connections: ['P1', 'P3', 'P4'], rfidTagId: 'RFID_P2' },
        { pointId: 'P3', x: 550, y: 235, label: 'Ngã tư phải', type: 'intersection', connections: ['S', 'P2', 'C'], rfidTagId: 'RFID_P3' },

        { pointId: 'A', x: 50, y: 420, label: 'Điểm A', type: 'destination', connections: ['P1', 'P4', 'ST'], rfidTagId: 'RFID_A' },
        { pointId: 'P4', x: 300, y: 420, label: 'Ngã tư trung tâm dưới', type: 'intersection', connections: ['P2', 'A', 'C', 'P5'], rfidTagId: 'RFID_P4' },
        { pointId: 'C', x: 550, y: 420, label: 'Điểm C', type: 'destination', connections: ['P3', 'P4', 'P6'], rfidTagId: 'RFID_C' },

        { pointId: 'ST', x: 50, y: 650, label: 'Stop (Kết thúc)', type: 'stop', connections: ['A', 'P5'], rfidTagId: 'RFID_ST' },
        { pointId: 'P5', x: 300, y: 650, label: 'Trung gian dưới', type: 'waypoint', connections: ['ST', 'P4', 'P6'], rfidTagId: null },
        { pointId: 'P6', x: 550, y: 650, label: 'Góc dưới phải', type: 'waypoint', connections: ['P5', 'C'], rfidTagId: null },
    ];

    const insPoint = db.prepare(`INSERT INTO map_points (point_id, x, y, label, type, connections, rfid_tag_id)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insRfid = db.prepare('INSERT INTO rfid_tags (rfid_id, name, x, y) VALUES (?, ?, ?, ?)');

    const transaction = db.transaction(() => {
        for (const p of points) {
            insPoint.run(p.pointId, p.x, p.y, p.label, p.type, JSON.stringify(p.connections), p.rfidTagId);
            if (p.rfidTagId) {
                insRfid.run(p.rfidTagId, p.label, p.x, p.y);
            }
        }
    });
    transaction();
}

module.exports = { getDb, initialize, seedDemoMap };
