const express = require('express');
const router = express.Router();

const userCtrl = require('../controllers/userController');
const { auth, requireRole } = require('../middlewares/auth');

console.log('typeof registerUser:', typeof userCtrl.registerUser);
console.log('typeof auth:', typeof auth);
console.log('typeof requireRole:', typeof requireRole);

// Public
router.post('/register', userCtrl.registerUser);

// Admin-only
router.get('/',      auth, requireRole('admin'), userCtrl.getAllUsers);
router.get('/:id',   auth, requireRole('admin'), userCtrl.getUserById);
router.put('/:id',   auth, requireRole('admin'), userCtrl.updateUser);
router.delete('/:id',auth, requireRole('admin'), userCtrl.deleteUser);

module.exports = router;
