const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');

// Đặt route cụ thể trước '/:id' để không bị nuốt
router.get('/', productController.listProducts);
router.get('/:id/options', productController.getProductOptions);
router.get('/:id/images', productController.getProductImages); // ✅ thêm handler tồn tại
router.get('/:id', productController.getProductDetails);

router.post('/', productController.addProduct);
router.put('/:id', productController.updateProduct);
router.delete('/:id', productController.deleteProduct);

module.exports = router;
