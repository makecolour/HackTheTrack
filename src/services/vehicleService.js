/**
 * Vehicle Service — single vehicle state management
 */
const { getDb } = require('../db');

class VehicleService {
    getStatus() {
        const db = getDb();
        return db.prepare('SELECT * FROM vehicle WHERE id = 1').get();
    }

    updatePosition(pointId, positionType = 'estimated') {
        const db = getDb();
        db.prepare("UPDATE vehicle SET current_point = ?, position_type = ?, updated_at = datetime('now') WHERE id = 1")
            .run(pointId, positionType);
        return this.getStatus();
    }

    updateHeading(dx, dy) {
        const db = getDb();
        db.prepare("UPDATE vehicle SET heading_dx = ?, heading_dy = ?, updated_at = datetime('now') WHERE id = 1")
            .run(dx, dy);
    }

    setDelivering(orderId) {
        const db = getDb();
        db.prepare("UPDATE vehicle SET status = 'delivering', delivery_order_id = ?, updated_at = datetime('now') WHERE id = 1")
            .run(orderId);
    }

    returnToStart() {
        const db = getDb();
        db.prepare("UPDATE vehicle SET current_point = 'S', position_type = 'confirmed', status = 'idle', delivery_order_id = NULL, updated_at = datetime('now') WHERE id = 1")
            .run();
    }

    reset() {
        const db = getDb();
        db.prepare("UPDATE vehicle SET current_point = 'S', position_type = 'unknown', status = 'idle', delivery_order_id = NULL, heading_dx = NULL, heading_dy = NULL, updated_at = datetime('now') WHERE id = 1")
            .run();
    }
}

module.exports = new VehicleService();
