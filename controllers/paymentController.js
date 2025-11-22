// controllers/paymentController.js
const { getPool, sql } = require('../config/db');

// ========== Helpers chung ==========
function extractOrderId(req) {
  const raw = req.params?.orderId ?? req.params?.id ?? req.query?.orderId ?? req.body?.orderId;
  const orderId = Number(raw);
  if (!Number.isFinite(orderId) || !Number.isInteger(orderId) || orderId <= 0) {
    return { ok: false, raw };
  }
  return { ok: true, value: orderId };
}

/**
 * Kiểm tra quyền truy cập đơn:
 * - admin: luôn được
 * - customer: được nếu:
 *   (1) Orders.CustomerID -> JOIN Customers.UserID = req.user.id, hoặc
 *   (2) Orders.CustomerID IS NULL và PaymentEmail == req.user.email
 */
async function canAccessOrder(pool, req, orderId) {
  const role = (req.user?.role || '').toString().toLowerCase();
  if (role === 'admin') return true;
  if (role !== 'customer') return false;

  const userId = Number(req.user?.id || req.user?.UserID || 0);
  const email = String(req.user?.email || req.user?.Email || '').trim().toLowerCase();

  const rs = await pool.request()
    .input('OrderID', sql.Int, orderId)
    .input('UserID', sql.Int, userId)
    .input('Email',  sql.NVarChar, email)
    .query(`
      SELECT 1
      FROM dbo.Orders o
      LEFT JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
      WHERE o.OrderID = @OrderID
        AND (
          (c.CustomerID IS NOT NULL AND c.UserID = @UserID)
          OR (c.CustomerID IS NULL AND LOWER(ISNULL(o.PaymentEmail,'')) = @Email)
        )
    `);

  return !!rs.recordset.length;
}

/** ===== Chuẩn hoá payment method về 1 trong: COD | MOMO | ATM | CARD ===== */
function normalizePaymentMethod(v) {
  const raw = String(v ?? 'COD')
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  const map = {
    'COD': 'COD',
    'CASH': 'COD',
    'MOMO': 'MOMO',
    'BANK': 'ATM',
    'ATM': 'ATM',
    'THE NOI DIA': 'ATM',
    'THE NOI DIA/ATM': 'ATM',
    'CARD': 'CARD',
    'VISA': 'CARD',
    'MASTERCARD': 'CARD',
    'VISA/MASTERCARD': 'CARD',
    'THE VISA/MASTERCARD': 'CARD',
  };

  let m = map[raw] ?? raw;
  if (m.startsWith('VISA')) m = 'CARD';
  return (['COD','MOMO','ATM','CARD'].includes(m)) ? m : 'COD';
}

/* =========================
   (Admin) GET /api/payments
========================= */
exports.getAllPayments = async (_req, res) => {
  try {
    const pool = await getPool();
    const rs = await pool.request().query(`
      SELECT p.PaymentID, p.OrderID, p.Method, p.Amount, p.Status, p.PaidAt, p.CreatedAt
      FROM dbo.Payments p
      ORDER BY p.CreatedAt DESC
    `);
    return res.json(rs.recordset);
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi lấy danh sách payments', error: err.message });
  }
};

/* ==============================================================
   (Admin/Customer) GET /api/payments/order/:orderId?
============================================================== */
exports.getPaymentByOrder = async (req, res) => {
  const id = extractOrderId(req);
  if (!id.ok) {
    return res.status(400).json({
      message: 'OrderID không hợp lệ/không được truyền',
      debug: { params: req.params, query: req.query, bodyHasOrderId: !!req.body?.orderId }
    });
  }
  const orderId = id.value;

  try {
    const pool = await getPool();

    // ✅ quyền
    if (!(await canAccessOrder(pool, req, orderId))) {
      return res.status(403).json({ message: 'Không có quyền xem payment của đơn này' });
    }

    const rs = await pool.request()
      .input('OrderID', sql.Int, orderId)
      .query(`
        SELECT TOP 1 PaymentID, OrderID, Method, Amount, Status, PaidAt, CreatedAt
        FROM dbo.Payments
        WHERE OrderID = @OrderID
        ORDER BY CreatedAt DESC
      `);

    if (!rs.recordset.length) {
      return res.status(404).json({ message: 'Chưa có payment' });
    }
    return res.json(rs.recordset[0]);
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi lấy payment', error: err.message });
  }
};

/* =====================================================================
   (Admin) POST /api/payments/mark-paid/:orderId?   Body: { method?: ... }
======================================================================== */
exports.markPaid = async (req, res) => {
  const id = extractOrderId(req);
  if (!id.ok) {
    return res.status(400).json({
      message: 'OrderID không hợp lệ/không được truyền',
      debug: { params: req.params, query: req.query, bodyHasOrderId: !!req.body?.orderId }
    });
  }
  const orderId = id.value;
  const methodStd = normalizePaymentMethod(req.body?.method);

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();
    const rq = new sql.Request(tx);

    // 1) Lock order row
    const ord = await rq
      .input('OrderID', sql.Int, orderId)
      .query(`
        SELECT OrderID, CustomerID, Total, Status
        FROM dbo.Orders WITH (UPDLOCK, ROWLOCK)
        WHERE OrderID = @OrderID
      `);

    if (!ord.recordset.length) {
      await tx.rollback();
      return res.status(404).json({ message: 'Không thấy order' });
    }

    const total = Number(ord.recordset[0].Total) || 0;

    // 2) Upsert payment
    const existed = await rq
      .input('OrderID2', sql.Int, orderId)
      .query(`
        SELECT TOP 1 PaymentID
        FROM dbo.Payments
        WHERE OrderID = @OrderID2
        ORDER BY CreatedAt DESC
      `);

    let paymentRow;

    if (existed.recordset.length) {
      paymentRow = (await rq
        .input('PaymentID', sql.Int, existed.recordset[0].PaymentID)
        .input('Method',    sql.NVarChar, methodStd)
        .input('Amount',    sql.Decimal(18, 2), total)
        .input('Status',    sql.NVarChar, 'PAID')
        .query(`
          UPDATE dbo.Payments
          SET Method = @Method,
              Amount = @Amount,
              Status = @Status,
              PaidAt = GETDATE()
          OUTPUT INSERTED.*
          WHERE PaymentID = @PaymentID
        `)).recordset[0];
    } else {
      paymentRow = (await rq
        .input('OrderID3', sql.Int, orderId)
        .input('Method2',  sql.NVarChar, methodStd)
        .input('Amount2',  sql.Decimal(18, 2), total)
        .input('Status2',  sql.NVarChar, 'PAID')
        .query(`
          INSERT INTO dbo.Payments (OrderID, Method, Amount, Status, PaidAt, CreatedAt)
          OUTPUT INSERTED.*
          VALUES (@OrderID3, @Method2, @Amount2, @Status2, GETDATE(), GETDATE())
        `)).recordset[0];
    }

    // 3) Update order status
    await rq
      .input('OrderID4', sql.Int, orderId)
      .input('Status4',  sql.NVarChar, 'Đang xử lý')
      .query(`
        UPDATE dbo.Orders
        SET Status = @Status4
        WHERE OrderID = @OrderID4
      `);

    await tx.commit();
    return res.json({ message: 'Đã đánh dấu thanh toán thành công', payment: paymentRow });
  } catch (err) {
    try { if (tx._aborted !== true) await tx.rollback(); } catch {}
    return res.status(500).json({ message: 'Lỗi mark paid', error: err.message });
  }
};

// ====== OTP payment flow (email) ======
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sendMail } = require('../utils/mailer');

const OTP_LEN = 6;
const OTP_TTL_MIN = Number(process.env.OTP_TTL_MINUTES || 10);
const RESEND_COOLDOWN_SEC = Number(process.env.OTP_RESEND_COOLDOWN_SEC || 60);
const MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);

function genOtp() {
  const n = crypto.randomInt(0, 1000000);
  return n.toString().padStart(OTP_LEN, '0');
}

async function createAndEmailOtp(orderId, email) {
  const otp = genOtp();
  const hash = await bcrypt.hash(otp, 10);
  const expireAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
  const now = new Date();

  const pool = await getPool();
  await pool.request()
    .input('orderId', sql.Int, orderId)
    .input('email', sql.NVarChar, email)
    .input('hash', sql.NVarChar, hash)
    .input('exp', sql.DateTime2, expireAt)
    .input('now', sql.DateTime2, now)
    .query(`
      UPDATE dbo.Orders SET
        PaymentEmail = @email,
        OtpHash = @hash,
        OtpExpireAt = @exp,
        OtpAttempts = 0,
        OtpLastSentAt = @now,
        OtpResendCount = ISNULL(OtpResendCount,0) + 1
      WHERE OrderID = @orderId
    `);

  const subject = `Mã thanh toán cho đơn #${orderId}`;
  const html = `
    <p>Xin chào,</p>
    <p>Mã thanh toán của đơn <b>#${orderId}</b> là:</p>
    <h2 style="letter-spacing:4px">${otp}</h2>
    <p>Mã có hiệu lực trong ${OTP_TTL_MIN} phút.</p>
  `;
  await sendMail({ to: email, subject, html, text: `OTP: ${otp}` });
}

/**
 * POST /api/payments/checkout
 * body: { email, orderId }
 */
exports.checkout = async (req, res) => {
  try {
    const { email, orderId } = req.body;
    if (!email || !orderId) return res.status(400).json({ ok: false, message: 'Thiếu email hoặc orderId' });

    const pool = await getPool();
    if (!(await canAccessOrder(pool, req, orderId))) {
      return res.status(403).json({ ok: false, message: 'Không có quyền' });
    }

    await createAndEmailOtp(orderId, email);
    return res.json({ ok: true, orderId, next: 'ENTER_OTP' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'Checkout failed' });
  }
};

exports.resendOtp = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ ok: false, message: 'Thiếu orderId' });

    const pool = await getPool();
    if (!(await canAccessOrder(pool, req, orderId))) {
      return res.status(403).json({ ok: false, message: 'Không có quyền' });
    }

    const r = await pool.request()
      .input('id', sql.Int, orderId)
      .query(`SELECT PaymentEmail, OtpLastSentAt FROM dbo.Orders WHERE OrderID=@id`);
    if (!r.recordset.length) return res.status(404).json({ ok: false, message: 'Không thấy đơn' });

    const { PaymentEmail: email, OtpLastSentAt: last } = r.recordset[0];
    if (!email) return res.status(400).json({ ok: false, message: 'Đơn chưa có email' });

    if (last && Date.now() - new Date(last).getTime() < RESEND_COOLDOWN_SEC * 1000) {
      return res.status(429).json({ ok: false, message: 'Gửi lại quá sớm, vui lòng đợi' });
    }

    await createAndEmailOtp(orderId, email);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'Không gửi lại được OTP' });
  }
};

/* ====== Ý định thanh toán (QR/deeplink) ====== */
exports.getPaymentIntent = async (req, res) => {
  try {
    const id = extractOrderId(req);
    if (!id.ok) return res.status(400).json({ message: 'Invalid order id', raw: id.raw });
    const orderId = id.value;

    const pool = await getPool();
    if (!(await canAccessOrder(pool, req, orderId))) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const rs = await pool.request()
      .input('OrderID', sql.Int, orderId)
      .query(`
        SELECT 
          o.Total,
          pa.Method AS PaymentMethod,
          pa.Amount AS PaymentAmount
        FROM dbo.Orders o
        OUTER APPLY (
          SELECT TOP 1 Method, Amount
          FROM dbo.Payments p
          WHERE p.OrderID = o.OrderID
          ORDER BY p.PaymentID DESC
        ) pa
        WHERE o.OrderID = @OrderID
      `);

    if (!rs.recordset.length) return res.status(404).json({ message: 'Not found' });

    const row = rs.recordset[0];
    const method = normalizePaymentMethod(row.PaymentMethod || 'MOMO'); // MOMO/ATM/CARD/COD
    const amount = Number(row.PaymentAmount ?? row.Total ?? 0);

    let qrData = '';
    let deeplink = '';

    if (method === 'MOMO') {
      qrData   = `PAY MOMO ORDER#${orderId} AMOUNT=${amount}`;
      deeplink = `momo://app?action=pay&amount=${amount}&description=ORDER%20${orderId}`;
    } else if (method === 'ATM') {
      qrData = `VietQR|970415|123456789|MaiTech Shop|${amount}|Don ${orderId}`;
    } // CARD/COD: không trả QR

    return res.json({ method, amount, qrData, deeplink });
  } catch (e) {
    console.error('[getPaymentIntent] ERROR:', e);
    return res.status(500).json({ message: 'intent error', error: String(e) });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { orderId, otp, cardNo, exp, cvv } = req.body;
    if (!orderId || !otp) {
      return res.status(400).json({ ok: false, message: 'Thiếu orderId/otp' });
    }

    const pool = await getPool();
    if (!(await canAccessOrder(pool, req, orderId))) {
      return res.status(403).json({ ok: false, message: 'Không có quyền' });
    }

    // 1) Nếu phương thức là CARD, bắt buộc có thông tin thẻ (demo validate)
    const pm = await pool.request()
      .input('id', sql.Int, orderId)
      .query(`
        SELECT TOP 1 Method
        FROM dbo.Payments
        WHERE OrderID=@id
        ORDER BY PaymentID DESC
      `);
    const method = String(pm.recordset?.[0]?.Method || '').toUpperCase();
    if (method === 'CARD') {
      if (!cardNo || !exp || !cvv) {
        return res.status(400).json({ ok:false, message:'Thiếu thông tin thẻ' });
      }
      if (!/^\d{12,19}$/.test(cardNo) || !/^\d{2}\/\d{2}$/.test(exp) || !/^\d{3,4}$/.test(cvv)) {
        return res.status(400).json({ ok:false, message:'Thông tin thẻ không hợp lệ' });
      }
      // TODO: gọi cổng thanh toán thật nếu cần
    }

    // 2) Đọc OTP hash / expire / attempts
    const r = await pool.request()
      .input('id', sql.Int, orderId)
      .query(`
        SELECT OtpHash, OtpExpireAt, OtpAttempts, PaymentVerifiedAt
        FROM dbo.Orders
        WHERE OrderID=@id
      `);

    if (!r.recordset.length) {
      return res.status(404).json({ ok: false, message: 'Không thấy đơn' });
    }
    const row = r.recordset[0];
    if (row.PaymentVerifiedAt) return res.json({ ok: true, already: true });

    if (row.OtpExpireAt && new Date(row.OtpExpireAt).getTime() < Date.now()) {
      return res.status(400).json({ ok: false, message: 'OTP hết hạn' });
    }
    if ((row.OtpAttempts || 0) >= MAX_ATTEMPTS) {
      return res.status(429).json({ ok: false, message: 'Thử quá số lần cho phép' });
    }

    // 3) So khớp OTP
    const match = await bcrypt.compare(String(otp), row.OtpHash || '');
    const attempts = (row.OtpAttempts || 0) + 1;

    if (!match) {
      // ❌ OTP sai: CHỈ tăng attempts, KHÔNG set Verified/Status
      await pool.request()
        .input('id', sql.Int, orderId)
        .input('a', sql.Int, attempts)
        .query(`UPDATE dbo.Orders SET OtpAttempts=@a WHERE OrderID=@id`);
      return res.status(400).json({ ok: false, message: 'OTP không đúng' });
    }

    // 4) OTP đúng: xác nhận thanh toán + chuyển trạng thái đơn
    await pool.request()
      .input('id', sql.Int, orderId)
      .query(`
        UPDATE dbo.Orders
        SET PaymentVerifiedAt = SYSUTCDATETIME(),
            Status = N'Đang xử lý'
        WHERE OrderID=@id
      `);

    await pool.request()
      .input('OrderID', sql.Int, orderId)
      .query(`
        UPDATE dbo.Payments
        SET Status = 'PAID', PaidAt = GETDATE()
        WHERE PaymentID = (
          SELECT TOP 1 PaymentID FROM dbo.Payments
          WHERE OrderID = @OrderID
          ORDER BY PaymentID DESC
        )
      `);

    return res.json({ ok: true, verified: true });
  } catch (e) {
    console.error('[verifyOtp] ERROR:', e);
    return res.status(500).json({ ok: false, message: 'Verify failed' });
  }
};
