// routes/admin.js
const router = require('express').Router();
const { authRequired, requireRole } = require('../middlewares/auth');
const adminController = require('../controllers/adminController');
const shipmentController = require('../controllers/shipmentController'); // 👈 THÊM DÒNG NÀY

// ADMIN & MANAGER mới vào được
router.use(authRequired, requireRole(['admin', 'manager']));

// Dashboard
router.get('/dashboard', adminController.getDashboard);

// ====== SHIPMENTS / DELIVERY ======

// List tất cả shipments (nếu FE có dùng)
router.get('/shipments', shipmentController.listShipments);

// Gán shipper cho đơn (FE gọi: POST /api/orders/:orderId/assign-shipper)
router.post('/orders/:orderId/assign-shipper', shipmentController.assignShipper);

// Bỏ gán shipper
router.post('/orders/:orderId/unassign-shipper', shipmentController.unassignShipper);

// Lấy tracking + info giao hàng
router.get('/orders/:orderId/track', shipmentController.getOrderTracking);

// Cập nhật trạng thái shipment (shipper bấm “Đang giao”, “Đã giao”…)
router.patch('/shipments/:id/status', shipmentController.updateShipmentStatus);

// Thêm điểm tracking (nếu sau này em cho gửi lat/lng)
router.post('/shipments/:id/track', shipmentController.appendTracking);

// ====== CÁC ROUTE MẪU CŨ CỦA EM (GIỮ NGUYÊN) ======
router.get('/inventory', async (_req, res) => res.json({ stock: [] }));
router.get('/products',  async (_req, res) => res.json({ items: [] }));
router.get('/shippers',  async (_req, res) => res.json({ shippers: [] }));

module.exports = router;
