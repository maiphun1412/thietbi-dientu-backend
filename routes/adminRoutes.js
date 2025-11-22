// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// GET /api/admin/dashboard
router.get('/dashboard', adminController.getDashboard);

// GET /api/admin/low-variant-product-ids
router.get('/admin/low-variant-product-ids', adminController.getLowVariantProductIds);

module.exports = router;
