const express = require('express');
const orderService = require('../services/orderService');
const mapService = require('../services/mapService');
const vehicleService = require('../services/vehicleService');
const logService = require('../services/logService');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// POST /api/orders/receive — AllAboutHack pushes an order via session configure
router.post('/receive', (req, res) => {
    const { destination_a, destination_b, session_id, note } = req.body;
    if (!destination_a) {
        return res.status(400).json({ success: false, message: 'destination_a required' });
    }
    const order = orderService.createFromBackend({
        destinationA: destination_a,
        destinationB: destination_b,
        note, sessionId: session_id
    });

    const io = req.app.get('io');
    if (io) io.emit('new-order', order);

    res.status(201).json({ success: true, data: order });
});

// GET /api/orders — all orders
router.get('/', authenticate, authorize('staff'), (_req, res) => {
    res.json({ success: true, data: orderService.getAllOrders() });
});

// GET /api/orders/current — active order
router.get('/current', authenticate, (req, res) => {
    res.json({ success: true, data: orderService.getCurrentOrder() });
});

// GET /api/orders/:id
router.get('/:id', authenticate, (req, res) => {
    const order = orderService.getOrderById(Number(req.params.id));
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, data: order });
});

// PUT /api/orders/:id/accept — competitor accepts order → auto-navigate to destination A
router.put('/:id/accept', authenticate, authorize('staff'), (req, res) => {
    const id = Number(req.params.id);
    let order = orderService.getOrderById(id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    order = orderService.updateStatus(id, 'accepted');

    // Start delivery to destination A
    orderService.updateStatus(id, 'delivering');
    vehicleService.setDelivering(id);

    const path = mapService.findPath('S', order.destination_a);

    const io = req.app.get('io');
    if (io) {
        io.emit('order-accepted', { order, path });

        const vehicle = vehicleService.getStatus();
        const heading = (vehicle.heading_dx != null && vehicle.heading_dy != null)
            ? [vehicle.heading_dx, vehicle.heading_dy] : null;

        io.to('hardware').emit('auto-navigate', {
            path, orderId: id, isReturn: false, heading
        });
    }

    logService.log('navigation_start', { orderId: id, destination: order.destination_a, path: path?.map(p => p.pointId) });
    res.json({ success: true, data: { order, path } });
});

// PUT /api/orders/:id/cancel
router.put('/:id/cancel', authenticate, authorize('staff'), (req, res) => {
    const order = orderService.cancelOrder(Number(req.params.id));
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const io = req.app.get('io');
    if (io) io.emit('order-cancelled', order);

    res.json({ success: true, data: order });
});

module.exports = router;
