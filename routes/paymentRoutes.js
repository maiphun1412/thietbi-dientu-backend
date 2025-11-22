// routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const { auth, requireRole } = require('../middlewares/auth');
const p = require('../controllers/paymentController');

// ===== Giữ nguyên các route sẵn có =====
router.get('/', auth, requireRole(['admin']), p.getAllPayments);
router.get('/order/:orderId', auth, requireRole(['customer','admin']), p.getPaymentByOrder);
router.post('/mark-paid/:orderId', auth, requireRole(['admin']), p.markPaid);

// ===== Thêm các route OTP (customer) =====
router.post('/checkout', auth, requireRole(['customer']), p.checkout);
router.post('/otp/resend', auth, requireRole(['customer']), p.resendOtp);
router.post('/otp/verify', auth, requireRole(['customer']), p.verifyOtp);

// ===== NEW: Ý định thanh toán để FE render QR / deeplink =====
router.get('/intent/:orderId', auth, requireRole(['customer','admin']), p.getPaymentIntent);
router.get('/intent/:id',      auth, requireRole(['customer','admin']), p.getPaymentIntent);

module.exports = router;
