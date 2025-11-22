// routes/categoryRoutes.js
const express = require('express');
const router = express.Router();
const categoryCtrl = require('../controllers/categoryController');

// ⚠️ NHỚ: vì đã mount ở app.use('/api/categories', router)
// nên ở đây CHỈ dùng '/' chứ KHÔNG viết '/api/categories' nữa
router.get('/', categoryCtrl.getAllCategories);
router.get('/:id/images', categoryCtrl.getCategoryImages);
router.get('/:id/image',  categoryCtrl.getMainCategoryImage);

module.exports = router; // ⚠️ bắt buộc phải export
