// routes/adminUserRoutes.js
const express = require('express');
const {
  listUsers,
  getUserDetail,
  updateUserBanStatus,
  updateUserRole,
} = require('../controllers/adminUserController');

const router = express.Router();

// Nếu em có middleware requireRole admin thì thêm vào đây
// const { requireAdmin } = require('../middlewares/requireRole');

// GET /api/admin/users
router.get('/', /* requireAdmin, */ listUsers);

// GET /api/admin/users/:id
router.get('/:id', /* requireAdmin, */ getUserDetail);

// PUT /api/admin/users/:id/ban
router.put('/:id/ban', /* requireAdmin, */ updateUserBanStatus);

// PUT /api/admin/users/:id/role
router.put('/:id/role', /* requireAdmin, */ updateUserRole);

module.exports = router;
