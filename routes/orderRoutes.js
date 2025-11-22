// routes/orderRoutes.js
const express = require('express');
const router = express.Router();

const { auth, requireRole } = require('../middlewares/auth');
const orderCtrl = require('../controllers/orderController');

// Debug log để chắc chắn controller export đủ hàm
console.log('[orderRoutes] getMyOrders         =', typeof orderCtrl.getMyOrders);
console.log('[orderRoutes] checkout            =', typeof orderCtrl.checkout);
console.log('[orderRoutes] getAllOrders        =', typeof orderCtrl.getAllOrders);
console.log('[orderRoutes] getOrderById        =', typeof orderCtrl.getOrderById);
console.log('[orderRoutes] updateOrderStatus   =', typeof orderCtrl.updateOrderStatus);
console.log('[orderRoutes] deleteOrder         =', typeof orderCtrl.deleteOrder);
console.log('[orderRoutes] getOrderItemsSimple =', typeof orderCtrl.getOrderItemsSimple);
console.log('[orderRoutes] getOrderSummary     =', typeof orderCtrl.getOrderSummary);
console.log('[orderRoutes] sendOtpEmail        =', typeof orderCtrl.sendOtpEmail);
console.log('[orderRoutes] cancelMyOrder       =', typeof orderCtrl.cancelMyOrder);

/*
  Guard nhỏ: nếu vì cấu hình/require lỗi mà auth/requireRole không trả về middleware,
  Express sẽ ném “argument handler must be a function”.
  Hai helper dưới đây đảm bảo luôn trả về function hợp lệ.
*/
const mustAuth =
  (typeof auth === 'function') ? auth : (_req, _res, next) => next();

// requireRole của bạn có thể nhận mảng hoặc rest params.
// Helper allow() này chấp cả hai kiểu để an toàn với mọi impl.
const allow = (...roles) => {
  if (typeof requireRole === 'function') {
    // nếu impl của bạn nhận mảng: requireRole(['a','b'])
    if (requireRole.length >= 1 && roles.length === 1 && Array.isArray(roles[0])) {
      return requireRole(roles[0]);
    }
    // nếu impl nhận rest: requireRole('a','b')
    return requireRole(...roles);
  }
  return (_req, _res, next) => next();
};

// ======================= Customer =======================
router.get('/my', mustAuth, allow('customer', 'admin'), orderCtrl.getMyOrders);
router.post('/checkout', mustAuth, allow('customer'), orderCtrl.checkout);

// ======================== Admin ========================
router.get('/', mustAuth, allow('admin'), orderCtrl.getAllOrders);

// Giữ PUT (đúng REST)
router.put('/:id/status', mustAuth, allow('admin'), orderCtrl.updateOrderStatus);

// ➕ Thêm POST để tương thích với FE đang gọi POST /api/orders/:id/status
router.post('/:id/status', mustAuth, allow('admin'), orderCtrl.updateOrderStatus);

// NEW: lấy danh sách sản phẩm (order items) của 1 đơn
// ⚠️ Đặt TRƯỚC '/:id' để không bị nuốt bởi route '/:id'
router.get('/:orderId/items', mustAuth, allow('customer', 'admin'), orderCtrl.getOrderItemsSimple);

// NEW: tóm tắt đơn để màn OTP hiển thị địa chỉ + tên sản phẩm + tổng tiền
// ⚠️ Cũng đặt TRƯỚC '/:id'
router.get('/:id/summary', mustAuth, allow('customer', 'admin'), orderCtrl.getOrderSummary);

// ➕ NEW: gửi OTP qua email cho chủ đơn hoặc admin
// ⚠️ Cũng đặt TRƯỚC '/:id'
router.post('/:id/send-otp', mustAuth, allow('customer', 'admin'), orderCtrl.sendOtpEmail);

// ➕ NEW: khách tự hủy đơn của mình (hoặc admin)
// ⚠️ Cũng đặt TRƯỚC '/:id'
router.post('/:id/cancel', mustAuth, allow('customer', 'admin'), orderCtrl.cancelMyOrder);

// Lấy chi tiết đơn (admin)
router.get('/:id', mustAuth, allow('admin'), orderCtrl.getOrderById);

// Xóa đơn (admin)
router.delete('/:id', mustAuth, allow('admin'), orderCtrl.deleteOrder);

module.exports = router;
