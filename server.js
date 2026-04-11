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
app.get('/stream', (req, res) => {
    const hwUrl = process.env.HARDWARE_URL || 'http://localhost:8765';
    const url = `${hwUrl}/stream`;
    const http_ = require('http');
    const proxy = http_.get(url, (upstream) => {
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res);
    });
    proxy.on('error', () => {
        if (!res.headersSent) res.status(502).json({ error: 'Hardware daemon not reachable' });
    });
    req.on('close', () => proxy.destroy());
});
app.get('/snapshot', (req, res) => {
    const hwUrl = process.env.HARDWARE_URL || 'http://localhost:8765';
    const url = `${hwUrl}/snapshot`;
    const http_ = require('http');
    const proxy = http_.get(url, (upstream) => {
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res);
    });
    proxy.on('error', () => {
        if (!res.headersSent) res.status(502).json({ error: 'Hardware daemon not reachable' });
    });
    req.on('close', () => proxy.destroy());
});

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
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => process.exit(0));
});
