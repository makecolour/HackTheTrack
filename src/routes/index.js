const express = require('express');
const authRoutes = require('./auth');
const mapRoutes = require('./map');
const orderRoutes = require('./orders');
const vehicleRoutes = require('./vehicle');
const hardwareRoutes = require('./hardware');
const productRoutes = require('./products');
const logRoutes = require('./logs');
const sessionRoutes = require('./session');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/map', mapRoutes);
router.use('/orders', orderRoutes);
router.use('/vehicle', vehicleRoutes);
router.use('/hardware', hardwareRoutes);
router.use('/products', productRoutes);
router.use('/robot-logs', logRoutes);
router.use('/session', sessionRoutes);

module.exports = router;
