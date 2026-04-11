const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { signToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password required' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = signToken(user);
    res.json({
        success: true,
        data: {
            token,
            user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role }
        }
    });
});

// GET /api/auth/me  (for token validation)
router.get('/me', (req, res) => {
    const { authenticate } = require('../middleware/auth');
    authenticate(req, res, () => {
        res.json({ success: true, data: req.user });
    });
});

module.exports = router;
