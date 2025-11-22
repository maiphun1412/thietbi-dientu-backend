const express = require('express');
const router = express.Router();

const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { auth } = require('../middlewares/auth');
const ctrl = require('../controllers/reviewController');

// ─── Storage cho ảnh review ────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, '..', 'public', 'uploads', 'reviews');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = Date.now() + '-' + file.originalname.replace(/\s+/g, '-');
    cb(null, safe);
  },
});
const upload = multer({ storage });

// ─── APIs ──────────────────────────────────────────────────────────────────────

// Lấy review + ảnh + thống kê
router.get('/product/:productId', ctrl.getProductReviews);

// Kiểm tra quyền review (trả về danh sách OrderItemID còn được review)
router.get('/product/:productId/can', auth, ctrl.canReview);

// Thêm review (kèm ảnh): hỗ trợ JSON (images[]) HOẶC multipart (images files)
router.post('/', auth, upload.array('images', 5), ctrl.addReview);

// Sửa / Xóa review
router.put('/:reviewId', auth, ctrl.updateReview);
router.delete('/:reviewId', auth, ctrl.deleteReview);

module.exports = router;
