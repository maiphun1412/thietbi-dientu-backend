// middlewares/requireRole.js

// Dùng lại requireRole đã định nghĩa trong middlewares/auth.js
const { requireRole } = require('./auth');

/**
 * Wrapper để tương thích code cũ:
 *   const requireRole = require('../middlewares/requireRole');
 *   router.get('/admin', auth, requireRole('admin'), ...)
 *
 * Bên trong sẽ gọi đúng requireRole(...roles) từ auth.js
 */
module.exports = (...roles) => requireRole(...roles);
