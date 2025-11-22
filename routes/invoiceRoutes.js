// routes/invoiceRoutes.js
const router = require('express').Router();
const { getInvoicePdf } = require('../controllers/invoiceController');
const { requireAdmin } = require('../middlewares/auth'); // nếu muốn bảo vệ

router.get('/:orderId/invoice', /* requireAdmin, */ getInvoicePdf);
module.exports = router;
