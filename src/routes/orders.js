const express = require('express');
const orderService = require('../services/orderService');
const mapService = require('../services/mapService');
const vehicleService = require('../services/vehicleService');
const logService = require('../services/logService');
const { authenticate, optionalAuth, authorize } = require('../middleware/auth');

const router = express.Router();

// POST /api/orders — create order (customer or guest)
router.post('/', optionalAuth, (req, res) => {
    const { items, destinationPoint, viaPoint, note } = req.body;
    if (!items || items.length === 0) {
        return res.status(400).json({ success: false, message: 'At least 1 item required' });
    }
    if (!destinationPoint) {
        return res.status(400).json({ success: false, message: 'Destination required' });
    }
    const totalPrice = items.reduce((sum, i) => sum + (i.price * (i.quantity || 1)), 0);
    const order = orderService.createOrder({
        items, totalPrice,
        customerId: req.user?.id,
        customerName: req.user?.displayName || req.body.customerName || 'Khách hàng',
        destinationPoint, viaPoint, note
    });

    const io = req.app.get('io');
    if (io) io.emit('new-order', order);

    res.status(201).json({ success: true, data: order });
});

// GET /api/orders — all orders (staff)
router.get('/', authenticate, authorize('staff'), (_req, res) => {
    res.json({ success: true, data: orderService.getAllOrders() });
});

// GET /api/orders/pending — pending orders
router.get('/pending', authenticate, authorize('staff'), (_req, res) => {
    res.json({ success: true, data: orderService.getPendingOrders() });
});

// GET /api/orders/my — customer's orders
router.get('/my', authenticate, (req, res) => {
    res.json({ success: true, data: orderService.getOrdersByCustomer(req.user.id) });
});

// GET /api/orders/:id
router.get('/:id', optionalAuth, (req, res) => {
    const order = orderService.getOrderById(Number(req.params.id));
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, data: order });
});

// PUT /api/orders/:id/confirm — staff confirms order → auto-navigate
router.put('/:id/confirm', authenticate, authorize('staff'), (req, res) => {
    const id = Number(req.params.id);
    const order = orderService.confirmOrder(id, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Start delivery
    orderService.startDelivery(id);
    vehicleService.setDelivering(id);

    // Calculate path
    const path = order.via_point
        ? mapService.findConstrainedPath('S', order.via_point, order.destination_point)
        : mapService.findPath('S', order.destination_point);

    const io = req.app.get('io');
    if (io) {
        io.emit('order-confirmed', { order, path });

        // Get current heading for continuous navigation
        const vehicle = vehicleService.getStatus();
        const heading = (vehicle.heading_dx != null && vehicle.heading_dy != null)
            ? [vehicle.heading_dx, vehicle.heading_dy] : null;

        io.to('hardware').emit('auto-navigate', {
            path, orderId: id, isReturn: false, heading
        });
    }

    logService.log('navigation_start', { orderId: id, path: path?.map(p => p.pointId) });

    res.json({ success: true, data: { order, path } });
});

// PUT /api/orders/:id/delivered — mark delivered
router.put('/:id/delivered', authenticate, authorize('staff'), (req, res) => {
    const order = orderService.markDelivered(Number(req.params.id));
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const io = req.app.get('io');
    if (io) io.emit('order-delivered', order);

    res.json({ success: true, data: order });
});

// PUT /api/orders/:id/customer-confirm — customer confirms receipt → return trip
router.put('/:id/customer-confirm', optionalAuth, (req, res) => {
    const id = Number(req.params.id);
    const order = orderService.markDelivered(id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const io = req.app.get('io');

    // Check if batch order — process next or return
    if (order.batch_id) {
        const next = orderService.getNextBatchOrder(order.batch_id, order.batch_order);
        if (next) {
            // Navigate to next destination
            orderService.confirmOrder(next.id, order.confirmed_by);
            orderService.startDelivery(next.id);
            const path = mapService.findPath(order.destination_point, next.destination_point);
            if (io && path) {
                io.to('hardware').emit('auto-navigate', { path, orderId: next.id, isReturn: false });
            }
            return res.json({ success: true, data: { order, next, action: 'next-delivery' } });
        }
    }

    // Return to start
    const returnPath = mapService.findPath(order.destination_point, 'S');
    if (io && returnPath) {
        io.to('hardware').emit('auto-navigate', { path: returnPath, orderId: id, isReturn: true });
    }

    res.json({ success: true, data: { order, action: 'returning' } });
});

// PUT /api/orders/:id/cancel
router.put('/:id/cancel', optionalAuth, (req, res) => {
    const order = orderService.cancelOrder(Number(req.params.id));
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const io = req.app.get('io');
    if (io) io.emit('order-cancelled', order);

    res.json({ success: true, data: order });
});

// POST /api/orders/:id/payment — mock payment confirmation
router.post('/:id/payment', optionalAuth, (req, res) => {
    const id = Number(req.params.id);
    const { method } = req.body; // cash, card, momo, etc.
    const order = orderService.getOrderById(id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Generate invoice
    const invoice = {
        invoiceId: `INV-${Date.now()}-${id}`,
        orderId: id,
        customerName: order.customer_name,
        destination: order.destination_point,
        items: (order.items || []).map(i => ({
            name: i.name, quantity: i.quantity, price: i.price, subtotal: i.price * i.quantity
        })),
        totalPrice: order.total_price,
        paymentMethod: method || 'cash',
        paidAt: new Date().toISOString(),
        status: 'paid'
    };

    const io = req.app.get('io');
    if (io) {
        io.emit('payment-confirmed', { orderId: id, invoice });
        if (order.customer_id) {
            io.to(`customer-${order.customer_id}`).emit('invoice-ready', invoice);
        }
    }

    logService.log('payment', { orderId: id, method: method || 'cash', total: order.total_price });

    res.json({ success: true, data: invoice });
});

module.exports = router;
