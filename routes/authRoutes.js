// routes/authRoutes.js
'use strict';

const express = require('express');
const router = express.Router();

const authCtrl = require('../controllers/authController');
const { auth: requireAuth } = require('../middlewares/auth');

// Log debug (có thể xóa sau)
router.use((req, _res, next) => {
  console.log('[AUTH ROUTER]', req.method, req.originalUrl, 'path=', req.path);
  next();
});

/**
 * Các endpoint Auth
 */
router.post('/login',           authCtrl.login);
router.post('/refresh',         authCtrl.refresh);
router.post('/logout',          authCtrl.logout);
router.post('/register',        authCtrl.register);
router.post('/change-password', requireAuth, authCtrl.changePassword);
router.post('/request-reset',   authCtrl.requestReset);
router.post('/verify-reset',    authCtrl.verifyReset);
router.post('/confirm-reset',   authCtrl.confirmReset);

module.exports = router;
