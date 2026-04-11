require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');

const db = require('./src/db');
const routes = require('./src/routes');
const setupSocket = require('./src/socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Share io with routes
app.set('io', io);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', routes);

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Camera stream proxy — relay MJPEG from hardware daemon so browser only needs port 3000
const HW_URL = process.env.HARDWARE_URL || 'http://localhost:8765';

function proxyToHardware(endpoint, req, res, retries = 3) {
    const http_ = require('http');
    const url = `${HW_URL}${endpoint}`;
    const attempt = () => {
        const proxy = http_.get(url, (upstream) => {
            res.writeHead(upstream.statusCode, upstream.headers);
            upstream.pipe(res);
        });
        proxy.on('error', () => {
            if (retries > 0 && !res.headersSent) {
                retries--;
                setTimeout(attempt, 1000);
            } else if (!res.headersSent) {
                res.status(502).json({ error: 'Hardware daemon not reachable' });
            }
        });
        req.on('close', () => proxy.destroy());
    };
    attempt();
}

app.get('/stream', (req, res) => proxyToHardware('/stream', req, res, 5));
app.get('/snapshot', (req, res) => proxyToHardware('/snapshot', req, res, 3));

// Socket.IO
setupSocket(io);

// SPA fallback — serve index.html for non-API routes
app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize database then start
db.initialize();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 Socket.IO ready`);

    // Auto-start hardware daemon if enabled
    if (process.env.ENABLE_HARDWARE === 'true') {
        spawnHardwareDaemon();
    }
});

// ── Hardware Daemon child process ──
let daemonProc = null;

function spawnHardwareDaemon() {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const daemonDir = path.join(__dirname, 'hardware');
    const daemonScript = path.join(daemonDir, 'daemon.py');

    if (!fs.existsSync(daemonScript)) {
        console.log('⚠️  Hardware daemon not found at hardware/daemon.py — skipping');
        return;
    }

    // Find python binary
    const python = process.platform === 'win32' ? 'python' : 'python3';

    console.log('🤖 Starting hardware daemon...');
    daemonProc = spawn(python, ['daemon.py'], {
        cwd: daemonDir,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    daemonProc.stdout.on('data', (data) => {
        String(data).split('\n').filter(Boolean).forEach(line =>
            console.log(`[hardware] ${line}`)
        );
    });

    daemonProc.stderr.on('data', (data) => {
        String(data).split('\n').filter(Boolean).forEach(line =>
            console.log(`[hardware] ${line}`)
        );
    });

    daemonProc.on('exit', (code, signal) => {
        if (signal) {
            console.log(`🤖 Hardware daemon killed (${signal})`);
        } else if (code !== 0) {
            console.log(`⚠️  Hardware daemon exited with code ${code} — restarting in 5s...`);
            setTimeout(spawnHardwareDaemon, 5000);
        } else {
            console.log('🤖 Hardware daemon stopped');
        }
        daemonProc = null;
    });

    daemonProc.on('error', (err) => {
        console.error(`⚠️  Failed to start hardware daemon: ${err.message}`);
        daemonProc = null;
    });
}

function killDaemon() {
    if (!daemonProc) return;
    console.log('🤖 Stopping hardware daemon...');
    daemonProc.kill('SIGTERM');
    // Force kill after 3 seconds if still alive
    const forceKill = setTimeout(() => {
        if (daemonProc) {
            daemonProc.kill('SIGKILL');
        }
    }, 3000);
    daemonProc.on('exit', () => clearTimeout(forceKill));
}

// Graceful shutdown — kill daemon + close server
function shutdown() {
    console.log('Shutting down...');
    killDaemon();
    server.close(() => process.exit(0));
    // Force exit after 5s if server won't close
    setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
