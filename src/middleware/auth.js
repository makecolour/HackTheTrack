const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'se-delivery-bot-2026';

function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Token required' });
    }
    try {
        const token = authHeader.split(' ')[1];
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
}

function optionalAuth(req, _res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        } catch { /* ignore */ }
    }
    next();
}

function authorize(...roles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        next();
    };
}

function signToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role, displayName: user.display_name },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
}

module.exports = { authenticate, optionalAuth, authorize, signToken };
