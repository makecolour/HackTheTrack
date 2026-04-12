/**
 * Order Service — simplified for SE Track (order pushed from AllAboutHack)
 */
const { getDb } = require('../db');

class OrderService {
    createFromBackend({ destinationA, destinationB, note, sessionId }) {
        const db = getDb();
        const result = db.prepare(`
            INSERT INTO orders (destination_a, destination_b, note, session_id, status)
            VALUES (?, ?, ?, ?, 'pending')
        `).run(destinationA, destinationB || null, note || '', sessionId || null);
        return this.getOrderById(result.lastInsertRowid);
    }

    getOrderById(id) {
        const db = getDb();
        return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
    }

    getAllOrders() {
        const db = getDb();
        return db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    }

    getCurrentOrder() {
        const db = getDb();
        return db.prepare("SELECT * FROM orders WHERE status NOT IN ('delivered','cancelled') ORDER BY created_at DESC LIMIT 1").get() || null;
    }

    updateStatus(id, status) {
        const db = getDb();
        db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
        return this.getOrderById(id);
    }

    cancelOrder(id) {
        return this.updateStatus(id, 'cancelled');
    }
}

module.exports = new OrderService();
