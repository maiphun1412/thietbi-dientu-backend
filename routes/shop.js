// routes/shop.js
const router = require('express').Router();
const { authRequired, requireRole } = require('../middlewares/auth');

// CUSTOMER, ADMIN, MANAGER đều vào được khu bán hàng
router.use(authRequired, requireRole(['customer','admin','manager']));

router.get('/catalog', async (_req, res) => res.json({ products: [] }));
router.get('/cart',    async (_req, res) => res.json({ items: [] }));
router.get('/orders',  async (_req, res) => res.json({ orders: [] }));

module.exports = router;
