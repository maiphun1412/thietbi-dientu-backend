// routes/shipperRoutes.js
const express = require('express');
const router = express.Router();

const { auth } = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');
const c = require('../controllers/shipperController');

// đặt route tĩnh trước để tránh bị nuốt bởi '/:id'
router.get('/helpers/search/all', auth, requireRole('admin'), c.searchAll);

// 👉 FE đang gọi /shipper/my-shipments nên map thêm path này
router.get(
  ['/me/shipments', '/my-shipments'],
  auth,
  requireRole(['shipper']),
  c.myShipments
);

// guard: chỉ cho phép id là số
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(404).json({ message: 'Not found' });
  next();
});

// ========================
// Admin/Ship/Location APIs
// ========================

// bật/tắt hoạt động (tên route mới, vẫn giữ /:id/toggle bên dưới cho tương thích)
router.patch('/:id/active',   auth, requireRole('admin'),             c.setActive);

// cập nhật vị trí hiện tại của shipper
router.post('/:id/location',  auth, requireRole(['shipper','admin']), c.upsertLocation);

// xem vị trí hiện tại của shipper
router.get('/:id/location',   auth, requireRole(['shipper','admin']), c.getLocation);

// ========================
// Admin CRUD (giữ nguyên)
// ========================
router.get('/',               auth, requireRole('admin'), c.list);
router.get('/:id',            auth, requireRole('admin'), c.detail);
router.post('/',              auth, requireRole('admin'), c.create);
router.put('/:id',            auth, requireRole('admin'), c.update);
router.delete('/:id',         auth, requireRole('admin'), c.remove);
router.patch('/:id/toggle',   auth, requireRole('admin'), c.toggleActive);

module.exports = router;
