// routes/addressRoutes.js
const express = require('express');
const router = express.Router();
const { auth, requireRole } = require('../middlewares/auth');
const c = require('../controllers/addressController');

// CHÚ Ý: truyền middleware là HÀM, không được gọi (). 
// Và requireRole nhận danh sách role như mảng.
router.get('/my',      auth, requireRole(['customer', 'admin']), c.getMyAddresses);
router.post('/',       auth, requireRole(['customer', 'admin']), c.addAddress);
router.put('/:id',     auth, requireRole(['customer', 'admin']), c.updateAddress);
router.delete('/:id',  auth, requireRole(['customer', 'admin']), c.deleteAddress);

module.exports = router;
