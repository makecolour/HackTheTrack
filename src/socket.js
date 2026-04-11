/**
 * Socket.IO event handler — ported from Hackathon2026
 * Handles: vehicle position, motor control, navigation, RFID
 */
const mapService = require('./services/mapService');
const vehicleService = require('./services/vehicleService');
const orderService = require('./services/orderService');
const logService = require('./services/logService');

function setupSocket(io) {
    io.on('connection', (socket) => {
        console.log(`Client connected: ${socket.id}`);

        // Join room (staff, customer, hardware)
        socket.on('join-room', (room) => {
            socket.join(room);
            console.log(`${socket.id} joined room: ${room}`);
        });

        // Customer room for targeted notifications
        socket.on('join-customer', (customerId) => {
            socket.join(`customer-${customerId}`);
        });

        // ── Vehicle position updates from hardware daemon ──
        socket.on('vehicle-position-update', (data) => {
            try {
                const { pointId } = data;
                const point = mapService.getPointById(pointId);
                const positionType = (point && point.rfidTagId) ? 'confirmed' : 'estimated';
                vehicleService.updatePosition(pointId, positionType);
                io.emit('vehicle-position', { pointId, positionType });
                logService.log(positionType === 'confirmed' ? 'rfid_scan' : 'position_update', { pointId, positionType });
            } catch (err) {
                console.error('Vehicle position update error:', err);
            }
        });

        // ── Hardware status from daemon ──
        socket.on('hardware-status', (status) => {
            io.to('staff').emit('hardware-status-update', status);
        });

        socket.on('motor-status', (status) => {
            io.to('staff').emit('motor-status-update', status);
        });

        // ── Navigation complete from daemon ──
        socket.on('navigation-complete', async (data) => {
            io.emit('navigation-complete', data);
            logService.log('navigation_complete', data);

            // Save heading
            if (data.heading && data.heading.length === 2) {
                vehicleService.updateHeading(data.heading[0], data.heading[1]);
            }

            // Return trip — reset vehicle
            if (data.isReturn) {
                vehicleService.returnToStart();
                io.emit('vehicle-returned', { message: 'Vehicle returned to start' });
                return;
            }

            // Delivery arrival
            if (data.orderId && !data.isReturn) {
                try {
                    const order = orderService.markArrived(data.orderId);
                    if (order) {
                        io.emit('order-arrived', {
                            order,
                            message: `Order #${order.id} arrived at ${order.destination_point}`
                        });
                    }
                } catch (err) {
                    console.error('Error handling nav complete:', err);
                }
            }
        });

        // ── Navigation real-time logs from daemon ──
        socket.on('navigation-log', (data) => {
            io.emit('navigation-log', data);
            if (data.x !== undefined && data.y !== undefined) {
                io.emit('vehicle-position-estimate', { x: data.x, y: data.y, positionType: 'estimated' });
            }
        });

        // ── Motor control from frontend ──
        socket.on('motor-control', (data) => {
            io.to('hardware').emit('motor-command', data);
            logService.log('motor_command', data);
        });

        // ── Auto-navigate from frontend ──
        socket.on('auto-navigate', (data) => {
            io.to('hardware').emit('auto-navigate', data);
            logService.log('navigation_start', data);
        });

        socket.on('stop-navigation', () => {
            io.to('hardware').emit('stop-navigation');
        });

        // ── RFID from frontend ──
        socket.on('rfid-start-scan', () => {
            io.to('hardware').emit('rfid-start-scan');
        });

        socket.on('rfid-stop-scan', () => {
            io.to('hardware').emit('rfid-stop-scan');
        });

        // ── RFID results from hardware ──
        socket.on('rfid-scanned', (data) => {
            io.emit('rfid-scanned', data);
            logService.log('rfid_scan', data);
        });

        socket.on('disconnect', () => {
            console.log(`Client disconnected: ${socket.id}`);
        });
    });
}

module.exports = setupSocket;
