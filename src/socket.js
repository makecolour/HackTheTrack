/**
 * Socket.IO event handler
 * Handles: vehicle position, motor control, navigation, RFID
 * Forwards logs to AllAboutHack in real-time
 */
const mapService = require('./services/mapService');
const vehicleService = require('./services/vehicleService');
const orderService = require('./services/orderService');
const logService = require('./services/logService');
const aahService = require('./services/allabouthackService');

function setupSocket(io) {
    io.on('connection', (socket) => {
        console.log(`Client connected: ${socket.id}`);

        // Join room (staff, hardware)
        socket.on('join-room', (room) => {
            socket.join(room);
            console.log(`${socket.id} joined room: ${room}`);
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
                // Forward to AllAboutHack
                aahService.send('vehicle_position', { pointId, positionType });
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
            aahService.send('navigation_complete', data);

            // Save heading
            if (data.heading && data.heading.length === 2) {
                vehicleService.updateHeading(data.heading[0], data.heading[1]);
            }

            // Return trip — reset vehicle
            if (data.isReturn) {
                vehicleService.returnToStart();
                io.emit('vehicle-returned', { message: 'Vehicle returned to start' });

                // Mark order delivered
                if (data.orderId) {
                    const order = orderService.updateStatus(data.orderId, 'delivered');
                    if (order) {
                        io.emit('order-delivered', order);
                        aahService.send('order_status', { orderId: order.id, status: 'delivered' });
                    }
                }
                return;
            }

            // Arrival at destination A
            if (data.orderId && !data.isReturn) {
                try {
                    const order = orderService.getOrderById(data.orderId);
                    if (order) {
                        const newStatus = order.status === 'delivering' ? 'arrived_a' : 'arrived_b';
                        const updated = orderService.updateStatus(data.orderId, newStatus);
                        io.emit('order-arrived', {
                            order: updated,
                            message: `Order #${updated.id} arrived at ${newStatus === 'arrived_a' ? updated.destination_a : updated.destination_b}`
                        });
                        aahService.send('order_status', { orderId: updated.id, status: newStatus });

                        // If arrived at A and there's a destination B, auto-navigate to B
                        if (newStatus === 'arrived_a' && updated.destination_b) {
                            setTimeout(() => {
                                orderService.updateStatus(data.orderId, 'delivering');
                                const path = mapService.findPath(updated.destination_a, updated.destination_b);
                                if (path) {
                                    const vehicle = vehicleService.getStatus();
                                    const heading = (vehicle.heading_dx != null && vehicle.heading_dy != null)
                                        ? [vehicle.heading_dx, vehicle.heading_dy] : null;
                                    io.to('hardware').emit('auto-navigate', {
                                        path, orderId: data.orderId, isReturn: false, heading
                                    });
                                    logService.log('navigation_start', { orderId: data.orderId, destination: updated.destination_b });
                                    aahService.send('navigation_start', { orderId: data.orderId, destination: updated.destination_b });
                                }
                            }, 2000);
                        }
                        // If arrived at B (or A with no B), navigate back to S
                        else {
                            setTimeout(() => {
                                orderService.updateStatus(data.orderId, 'returning');
                                const dest = updated.destination_b || updated.destination_a;
                                const returnPath = mapService.findPath(dest, 'S');
                                if (returnPath) {
                                    io.to('hardware').emit('auto-navigate', {
                                        path: returnPath, orderId: data.orderId, isReturn: true
                                    });
                                    logService.log('navigation_start', { orderId: data.orderId, destination: 'S', isReturn: true });
                                    aahService.send('navigation_start', { orderId: data.orderId, destination: 'S', isReturn: true });
                                }
                            }, 2000);
                        }
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

        // ── RFID results from hardware ──
        socket.on('rfid-scanned', (data) => {
            io.emit('rfid-scanned', data);
            logService.log('rfid_scan', data);
            aahService.send('rfid_scan', data);

            // Match RFID UID to a map point and update position
            const uid = data.uid || data.rfidId;
            if (!uid) return;
            const point = mapService.getPointByRfid(uid);
            if (!point) return;

            const prevVehicle = vehicleService.getStatus();
            const prevPoint = prevVehicle ? prevVehicle.current_point : null;

            // Update vehicle position (confirmed via RFID)
            vehicleService.updatePosition(point.pointId, 'confirmed');
            io.emit('vehicle-position', { pointId: point.pointId, positionType: 'confirmed' });
            aahService.send('vehicle_position', { pointId: point.pointId, positionType: 'confirmed' });

            // Detect crossed lines: find path from prev → new and mark all edges
            if (prevPoint && prevPoint !== point.pointId) {
                const path = mapService.findPath(prevPoint, point.pointId);
                if (path && path.length >= 2) {
                    const lines = [];
                    for (let i = 0; i < path.length - 1; i++) {
                        const lineKey = [path[i].pointId, path[i + 1].pointId].sort().join('-');
                        lines.push({ from: path[i].pointId, to: path[i + 1].pointId, lineKey });
                    }
                    io.emit('lines-crossed', { lines });
                    lines.forEach(line => {
                        logService.log('line_crossed', line);
                        aahService.send('line_crossed', line);
                    });
                }
            }
        });

        socket.on('disconnect', () => {
            console.log(`Client disconnected: ${socket.id}`);
        });
    });
}

module.exports = setupSocket;
