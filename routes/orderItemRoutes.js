// routes/orderItemRoutes.js
const express = require('express');
const router = express.Router();
const { auth, requireRole } = require('../middlewares/auth');
const c = require('../controllers/orderItemController');

// Chỉ admin
router.get('/',       auth, requireRole('admin'), c.getAllOrderItems);
router.get('/:id',    auth, requireRole('admin'), c.getOrderItemById);
router.post('/',      auth, requireRole('admin'), c.addOrderItem);
router.put('/:id',    auth, requireRole('admin'), c.updateOrderItem);
router.delete('/:id', auth, requireRole('admin'), c.deleteOrderItem);

module.exports = router;
