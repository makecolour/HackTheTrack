/**
 * Map Service — Dijkstra pathfinding (ported from Hackathon2026, adapted to SQLite)
 */
const { getDb } = require('../db');

class MapService {
    getAllPoints() {
        const db = getDb();
        return db.prepare('SELECT * FROM map_points').all().map(this._mapRow);
    }

    getPointById(pointId) {
        const db = getDb();
        const row = db.prepare('SELECT * FROM map_points WHERE point_id = ?').get(pointId);
        return row ? this._mapRow(row) : null;
    }

    getPointByRfid(rfidTagId) {
        const db = getDb();
        const row = db.prepare('SELECT * FROM map_points WHERE rfid_tag_id = ?').get(rfidTagId);
        return row ? this._mapRow(row) : null;
    }

    getDestinations() {
        const db = getDb();
        return db.prepare("SELECT * FROM map_points WHERE type = 'destination'").all().map(this._mapRow);
    }

    getStartPoint() {
        const db = getDb();
        const row = db.prepare("SELECT * FROM map_points WHERE type IN ('start', 'warehouse') LIMIT 1").get();
        return row ? this._mapRow(row) : null;
    }

    /**
     * Dijkstra shortest path from startId to endId
     * Returns array of point objects or null if no path
     */
    findPath(startId, endId) {
        const allPoints = this.getAllPoints();
        const pointMap = {};
        allPoints.forEach(p => { pointMap[p.pointId] = p; });

        if (!pointMap[startId] || !pointMap[endId]) return null;

        const getWeight = (id1, id2) => {
            const p1 = pointMap[id1];
            const p2 = pointMap[id2];
            return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
        };

        const dist = {};
        const prev = {};
        const visited = new Set();
        const pq = [];

        allPoints.forEach(p => { dist[p.pointId] = Infinity; });
        dist[startId] = 0;
        pq.push({ id: startId, dist: 0 });

        while (pq.length > 0) {
            pq.sort((a, b) => a.dist - b.dist);
            const { id: current } = pq.shift();

            if (visited.has(current)) continue;
            visited.add(current);
            if (current === endId) break;

            const currentPoint = pointMap[current];
            if (!currentPoint) continue;

            for (const neighbor of currentPoint.connections) {
                if (visited.has(neighbor) || !pointMap[neighbor]) continue;
                const weight = getWeight(current, neighbor);
                const newDist = dist[current] + weight;
                if (newDist < dist[neighbor]) {
                    dist[neighbor] = newDist;
                    prev[neighbor] = current;
                    pq.push({ id: neighbor, dist: newDist });
                }
            }
        }

        if (dist[endId] === Infinity) return null;

        const path = [];
        let node = endId;
        while (node) {
            path.unshift(pointMap[node]);
            node = prev[node];
        }
        return path;
    }

    /**
     * Constrained path: start → via → end (two Dijkstra runs)
     */
    findConstrainedPath(startId, viaId, endId) {
        const firstLeg = this.findPath(startId, viaId);
        if (!firstLeg) return null;

        const secondLeg = this.findPath(viaId, endId);
        if (!secondLeg) return null;

        return [...firstLeg, ...secondLeg.slice(1)];
    }

    _mapRow(row) {
        return {
            pointId: row.point_id,
            x: row.x,
            y: row.y,
            label: row.label,
            type: row.type,
            connections: JSON.parse(row.connections),
            rfidTagId: row.rfid_tag_id
        };
    }
}

module.exports = new MapService();
