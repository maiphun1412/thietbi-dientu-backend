const express = require('express');
const router = express.Router();
const { getAllWarrantyCards, addWarrantyCard } = require('../controllers/warrantyController');

// Lấy tất cả thẻ bảo hành
router.get('/', getAllWarrantyCards);

// Thêm thẻ bảo hành mới
router.post('/', addWarrantyCard);

module.exports = router;
