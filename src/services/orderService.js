/**
 * Order Service — CRUD + status transitions
 */
const { getDb } = require('../db');

class OrderService {
    createOrder({ items, totalPrice, customerId, customerName, destinationPoint, viaPoint, note, batchId, batchOrder }) {
        const db = getDb();
        const result = db.prepare(`
            INSERT INTO orders (customer_id, customer_name, destination_point, via_point, status, total_price, note, batch_id, batch_order)
            VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(customerId || null, customerName || 'Khách hàng', destinationPoint, viaPoint || null, totalPrice || 0, note || '', batchId || null, batchOrder || null);

        const orderId = result.lastInsertRowid;

        const insItem = db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity) VALUES (?, ?, ?, ?, ?)');
        for (const item of (items || [])) {
            insItem.run(orderId, item.productId || null, item.name, item.price, item.quantity || 1);
        }

        return this.getOrderById(orderId);
    }

    getOrderById(id) {
        const db = getDb();
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        if (!order) return null;
        order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
        return order;
    }

    getAllOrders() {
        const db = getDb();
        const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
        const getItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
        return orders.map(o => ({ ...o, items: getItems.all(o.id) }));
    }

    getPendingOrders() {
        const db = getDb();
        const orders = db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at ASC").all();
        const getItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
        return orders.map(o => ({ ...o, items: getItems.all(o.id) }));
    }

    getOrdersByCustomer(customerId) {
        const db = getDb();
        return db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC').all(customerId);
    }

    confirmOrder(id, staffId) {
        const db = getDb();
        db.prepare("UPDATE orders SET status = 'confirmed', confirmed_by = ?, updated_at = datetime('now') WHERE id = ?").run(staffId, id);
        return this.getOrderById(id);
    }

    startDelivery(id) {
        const db = getDb();
        db.prepare("UPDATE orders SET status = 'delivering', vehicle_status = 'moving', updated_at = datetime('now') WHERE id = ?").run(id);
        return this.getOrderById(id);
    }

    markArrived(id) {
        const db = getDb();
        db.prepare("UPDATE orders SET status = 'arrived', vehicle_status = 'arrived', updated_at = datetime('now') WHERE id = ?").run(id);
        return this.getOrderById(id);
    }

    markDelivered(id) {
        const db = getDb();
        db.prepare("UPDATE orders SET status = 'delivered', updated_at = datetime('now') WHERE id = ?").run(id);
        return this.getOrderById(id);
    }

    cancelOrder(id) {
        const db = getDb();
        db.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(id);
        return this.getOrderById(id);
    }

    /**
     * For batch orders: get next undelivered order in same batch
     */
    getNextBatchOrder(batchId, currentBatchOrder) {
        const db = getDb();
        return db.prepare(`
            SELECT * FROM orders 
            WHERE batch_id = ? AND batch_order > ? AND status IN ('pending', 'confirmed')
            ORDER BY batch_order ASC LIMIT 1
        `).get(batchId, currentBatchOrder);
    }

    /**
     * Get all arrived orders at a destination for batch processing
     */
    getArrivedAtDestination(destinationPoint) {
        const db = getDb();
        return db.prepare("SELECT * FROM orders WHERE destination_point = ? AND status = 'arrived'").all(destinationPoint);
    }
}

module.exports = new OrderService();
