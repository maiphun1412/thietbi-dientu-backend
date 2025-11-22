// routes/adminCategoryRoutes.js
'use strict';

const express = require('express');
const router = express.Router();

const {
  getAllCategories,
  getCategoryById,
  getCategoryImages,
  createCategory,
  updateCategory,
  deleteCategory,
} = require('../controllers/categoryController');

// ---- ép lấy auth middleware an toàn (function) ----
function resolveAuth() {
  const m = require('../middlewares/auth');
  if (typeof m === 'function') return m;
  if (m && typeof m.auth === 'function') return m.auth;
  throw new Error('[adminCategoryRoutes] "auth" không phải function (kiểm tra middlewares/auth.js)');
}

// ---- ép lấy requireRole factory an toàn (function(role)->middleware) ----
function resolveRequireRole() {
  try {
    const rr = require('../middlewares/requireRole');
    if (typeof rr === 'function') return rr;
    if (rr && typeof rr.requireRole === 'function') return rr.requireRole;
  } catch (_) { /* optional file, bỏ qua */ }
  const m = require('../middlewares/auth');
  if (m && typeof m.requireRole === 'function') return m.requireRole;
  throw new Error('[adminCategoryRoutes] "requireRole" không phải function (kiểm tra middlewares/requireRole.js hoặc middlewares/auth.js)');
}

const auth = resolveAuth();
const requireRole = resolveRequireRole();

// ---- helper: luôn đảm bảo handler là function để tránh ném TypeError từ router ----
function ensureHandler(fn, name) {
  if (typeof fn === 'function') return fn;
  console.error(`[adminCategoryRoutes] Handler "${name}" không phải function. Kiểm tra export trong controllers/categoryController.js`);
  // Trả về 500 thay vì làm vỡ app ở thời điểm register route
  return function __missingHandler__(req, res) {
    res.status(500).json({
      ok: false,
      message: `Handler "${name}" không khả dụng. Vui lòng kiểm tra controllers/categoryController.js`,
    });
  };
}

// ---- luôn truyền function thật sự vào router.use ----
router.use((req, res, next) => auth(req, res, next));
router.use((req, res, next) => requireRole('admin')(req, res, next));

// ===== Admin Category APIs =====
router.get('/',            ensureHandler(getAllCategories,  'getAllCategories'));
router.get('/:id',         ensureHandler(getCategoryById,   'getCategoryById'));
router.get('/:id/images',  ensureHandler(getCategoryImages, 'getCategoryImages'));
router.post('/',           ensureHandler(createCategory,    'createCategory'));
router.put('/:id',         ensureHandler(updateCategory,    'updateCategory'));
router.delete('/:id',      ensureHandler(deleteCategory,    'deleteCategory'));

module.exports = router;
