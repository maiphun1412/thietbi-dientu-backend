// routes/adminProductRoutes.js
'use strict';

const express = require('express');
const router  = express.Router();

const ctrl = require('../controllers/adminProductController');
const { upload } = require('../utils/upload');

// ==== Import middlewares an toàn cho cả 2 kiểu export ====
//  - middlewares/auth.js có thể export mặc định (module.exports = fn)
//    hoặc export dạng object { auth, requireRole }
const authModule = require('../middlewares/auth');
const auth = typeof authModule === 'function' ? authModule : authModule.auth;

let requireRole = null;
try {
  // ưu tiên file riêng nếu có
  const rr = require('../middlewares/requireRole');
  requireRole = typeof rr === 'function' ? rr : rr.requireRole;
} catch (_) {
  // nếu không có file riêng, lấy từ authModule
  requireRole = authModule.requireRole;
}

if (typeof auth !== 'function') {
  throw new Error('[adminProductRoutes] "auth" không phải function. Kiểm tra middlewares/auth.js');
}
if (typeof requireRole !== 'function') {
  throw new Error('[adminProductRoutes] "requireRole" không phải function. Kiểm tra middlewares/requireRole.js hoặc auth.js');
}

// tất cả route dưới đây yêu cầu JWT và role admin
router.use(auth, requireRole('admin'));

// ========== CRUD products ==========
router.get('/',        ctrl.list);
router.get('/:id',     ctrl.detail);

// FE gửi field tên 'files' (xem AdminProductService.createWithImages/updateWithImages)
router.post('/',       upload.array('files', 10), ctrl.create);
router.put('/:id',     upload.array('files', 10), ctrl.update);

router.delete('/:id',  ctrl.remove);

// ========== Images ==========
// đặt ảnh đại diện
router.put('/:id/images/:imageId/main', ctrl.setMainImage);

// FE đang gọi xoá ảnh: /api/admin/products/images/:imageId (không có :id)
router.delete('/images/:imageId',        ctrl.deleteImage);
// (optional) vẫn hỗ trợ thêm dạng có :id nếu nơi khác có dùng
router.delete('/:id/images/:imageId',    ctrl.deleteImage);

// ========== Options (variants) ==========
router.post('/:id/options',        ctrl.addOption);
router.put('/options/:optionId',   ctrl.updateOption);
router.delete('/options/:optionId',ctrl.deleteOption);

module.exports = router;
