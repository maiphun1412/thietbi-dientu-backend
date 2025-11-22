// routes/couponRoutes.js
const express = require('express');
const {
  getAllCoupons,
  addCoupon,
  updateCoupon,
  deleteCoupon,
} = require('../controllers/couponController');

const router = express.Router();

// GET /api/coupons
router.get('/', getAllCoupons);

// POST /api/coupons
router.post('/', addCoupon);

// PUT /api/coupons/:id
router.put('/:id', updateCoupon);

// DELETE /api/coupons/:id
router.delete('/:id', deleteCoupon);

module.exports = router;
