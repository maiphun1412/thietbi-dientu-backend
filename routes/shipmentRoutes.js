// routes/shipmentRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/shipmentController');

// Admin
router.get('/shipments', ctrl.listShipments);
router.patch('/shipments/:id/status', ctrl.updateShipmentStatus);

// Assign / Unassign
router.post('/orders/:orderId/assign-shipper',   ctrl.assignShipper);
router.post('/orders/:orderId/unassign-shipper', ctrl.unassignShipper);

// Shipper
router.post('/shipments/:id/track', ctrl.appendTracking);

// Customer
router.get('/orders/:orderId/track', ctrl.getOrderTracking);

module.exports = router;
