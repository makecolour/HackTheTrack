const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/products
router.get('/', (_req, res) => {
    const db = getDb();
    const products = db.prepare('SELECT * FROM products WHERE available = 1').all();
    res.json({ success: true, data: products });
});

module.exports = router;
