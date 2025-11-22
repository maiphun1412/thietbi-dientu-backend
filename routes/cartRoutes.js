const express = require('express');
const router = express.Router();
const { auth } = require('../middlewares/auth');
const cart = require('../controllers/cartController');

router.get('/my', auth, cart.getMyCart);

router.post('/add', auth, cart.addToCart);

router.patch('/quantity', auth, cart.updateQuantity);
router.post('/quantity', auth, cart.updateQuantity);

// 🔧 Tách làm 2 route, tránh ":optionId?"
router.delete('/item/:productId/:optionId', auth, cart.removeFromCart);
router.delete('/item/:productId', auth, cart.removeFromCart);

router.delete('/clear', auth, cart.clearCart);

module.exports = router;
