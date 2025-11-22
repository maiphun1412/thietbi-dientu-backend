// controllers/authController.js
const db = require('../config/db'); // ⬅️ dùng chung pool/msnodesqlv8
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Lấy sql & poolPromise từ config/db
const sql = db.sql;
const poolPromise = db.poolPromise;

/* ---------------- JWT helpers ---------------- */
const signAccess  = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });

const signRefresh = (payload) =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

/* ========= ensureCustomerForUser (tạo Customers nếu chưa có) =========
   - Nhận pool đã connect
   - Đảm bảo 1-1 giữa Users(UserID) và Customers(UserID)
   - Copy FullName/Phone/Email từ Users để tiện theo dõi (nếu có)
*/
async function ensureCustomerForUser(pool, userId) {
  // Đã có thì trả về luôn
  const chk = await pool.request()
    .input('UserID', sql.Int, userId)
    .query(`SELECT TOP 1 CustomerID FROM dbo.Customers WHERE UserID=@UserID`);
  if (chk.recordset[0]?.CustomerID) return chk.recordset[0].CustomerID;

  // Lấy thông tin từ Users
  const u = await pool.request()
    .input('UserID', sql.Int, userId)
    .query(`SELECT TOP 1 FullName, Phone, Email FROM dbo.Users WHERE UserID=@UserID`);
  const fullName = u.recordset[0]?.FullName || null;
  const phone    = u.recordset[0]?.Phone    || null;
  const email    = u.recordset[0]?.Email    || null;

  // Tạo Customers mức "Standard" và LoyaltyPoint=0
  const ins = await pool.request()
    .input('UserID',   sql.Int, userId)
    .input('FullName', sql.NVarChar(255), fullName)
    .input('Phone',    sql.NVarChar(50),  phone)
    .input('Email',    sql.NVarChar(255), email)
    .query(`
      INSERT INTO dbo.Customers (UserID, FullName, Phone, Email, IsActive, Tier, LoyaltyPoint, CreatedAt)
      OUTPUT INSERTED.CustomerID AS CustomerID
      VALUES (@UserID, @FullName, @Phone, @Email, 1, 'Standard', 0, SYSDATETIME())
    `);
  return ins.recordset[0].CustomerID;
}

/* ========= ensureShipperForUser (tạo Shippers nếu chưa có) =========
   - Nhận pool đã connect
   - Dùng khi user có role = shipper
*/
async function ensureShipperForUser(pool, userId) {
  await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM dbo.Shippers WHERE UserID = @userId)
      BEGIN
        INSERT INTO dbo.Shippers(Name, Phone, IsActive, CreatedAt, UserID)
        SELECT FullName, Phone, 1, SYSUTCDATETIME(), UserID
        FROM dbo.Users
        WHERE UserID = @userId;
      END
    `);
}

/* =================== Auth Controllers =================== */

/** POST /api/auth/login */
exports.login = async (req, res) => {
  const emailRaw = (req.body?.email ?? '').toString().trim().toLowerCase();
  const password = (req.body?.password ?? '').toString();

  if (!emailRaw || !password)
    return res.status(400).json({ message: 'Thiếu email/password' });

  try {
    const pool = await poolPromise;

    const rs = await pool.request()
      .input('Email', sql.NVarChar(256), emailRaw)
      .query(`
        SELECT TOP 1 UserID, Email, FullName, PasswordHash, Role, IsActive
        FROM dbo.Users
        WHERE Email = @Email COLLATE Latin1_General_CI_AS
      `);

    const user = rs.recordset[0];
    if (!user) return res.status(401).json({ message: 'Sai email hoặc mật khẩu' });

    const rawHash = String(user.PasswordHash || '').trim();

    // Nếu DB lưu plain-text (cũ) thì vẫn cho so sánh rơi dự phòng
    let ok = false;
    if (/^\$2[aby]\$/.test(rawHash)) ok = await bcrypt.compare(password, rawHash);
    else ok = (password === rawHash);

    if (!ok) return res.status(401).json({ message: 'Sai email hoặc mật khẩu' });
    if (user.IsActive === false) return res.status(403).json({ message: 'Tài khoản bị khoá' });

    // Chuẩn hoá role (hỗ trợ ADMIN / CUSTOMER / SHIPPER ...)
    const roleLower = String(user.Role || '').toLowerCase();

    // 🔒 Đảm bảo có Customers record cho user này (phục vụ FK ở Orders)
    // ➜ Chỉ tạo cho khách hàng, không cần cho admin / shipper
    if (roleLower === 'customer') {
      try { await ensureCustomerForUser(pool, user.UserID); } catch (_) {}
    }

    const payload = { id: user.UserID, email: user.Email, role: roleLower };
    const accessToken  = signAccess(payload);
    const refreshToken = signRefresh(payload);

    return res.json({
      accessToken,
      user: {
        UserID: user.UserID,
        Email: user.Email,
        FullName: user.FullName,
        Role: roleLower
      },
      // Dev có thể nhận refreshToken; prod thì không trả
      ...(process.env.NODE_ENV !== 'production' && { refreshToken })
    });
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi đăng nhập', error: err.message });
  }
};

/** POST /api/auth/refresh */
exports.refresh = (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken)
    return res.status(400).json({ message: 'Thiếu refreshToken' });

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const newAccess = signAccess({
      id: decoded.id,
      email: decoded.email,
      role: decoded.role
    });
    return res.json({ accessToken: newAccess });
  } catch (err) {
    return res
      .status(401)
      .json({ message: 'Refresh token không hợp lệ/đã hết hạn' });
  }
};

/** POST /api/auth/logout */
exports.logout = (_req, res) => {
  return res.json({ message: 'Đã đăng xuất' });
};

/** POST /api/auth/register */
exports.register = async (req, res) => {
  const fullName = (req.body?.fullName ?? '').toString().trim();
  const emailRaw = (req.body?.email ?? '').toString().trim().toLowerCase();
  const password = (req.body?.password ?? '').toString();
  const phone    = (req.body?.phone ?? null);

  // role gửi từ FE (nếu có), mặc định customer
  const roleRaw = (req.body?.role ?? 'customer').toString().trim().toLowerCase();
  const allowedRoles = ['customer', 'admin', 'shipper'];
  const role = allowedRoles.includes(roleRaw) ? roleRaw : 'customer';

  if (!fullName || !emailRaw || !password) {
    return res.status(400).json({ message: 'Vui lòng nhập đủ họ tên, email, mật khẩu' });
  }

  try {
    const pool = await poolPromise;

    // check trùng email
    const existed = await pool.request()
      .input('Email', sql.NVarChar(256), emailRaw)
      .query('SELECT 1 FROM dbo.Users WHERE Email = @Email COLLATE Latin1_General_CI_AS');
    if (existed.recordset.length > 0) {
      return res.status(409).json({ message: 'Email đã tồn tại' });
    }

    const hash = await bcrypt.hash(password, 10);

    const rs = await pool.request()
      .input('Email',        sql.NVarChar(256), emailRaw)
      .input('PasswordHash', sql.NVarChar(255), hash)
      .input('FullName',     sql.NVarChar(255), fullName)
      .input('Phone',        sql.NVarChar(50),  phone ?? null)
      .input('IsActive',     sql.Bit, true)
      .input('Role',         sql.NVarChar(50), role) // 👈 dùng role tính toán ở trên
      .query(`
        INSERT INTO dbo.Users (Email, PasswordHash, FullName, Phone, IsActive, Role, CreatedAt)
        OUTPUT inserted.UserID, inserted.Email, inserted.FullName, inserted.Role, inserted.CreatedAt
        VALUES (@Email, @PasswordHash, @FullName, @Phone, @IsActive, @Role, SYSDATETIME())
      `);

    const user = rs.recordset[0];
    const roleLower = String(user.Role || '').toLowerCase();

    // Nếu là shipper -> đảm bảo có bản ghi trong Shippers
    if (roleLower === 'shipper') {
      try { await ensureShipperForUser(pool, user.UserID); } catch (_) {}
    }

    // Nếu là customer -> tạo Customers (như cũ)
    if (roleLower === 'customer') {
      try { await ensureCustomerForUser(pool, user.UserID); } catch (_) {}
    }

    return res.status(201).json({
      message: 'Đăng ký thành công, vui lòng đăng nhập',
      user
    });
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi đăng ký', error: err.message });
  }
};

/** POST /api/auth/change-password */
exports.changePassword = async (req, res) => {
  try {
    const userId = req.user?.id; 
    const { currentPassword, newPassword } = req.body || {};

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Thiếu currentPassword/newPassword' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Mật khẩu mới tối thiểu 6 ký tự' });
    }

    const pool = await poolPromise;
    const rs = await pool.request()
      .input('UserID', sql.Int, userId)
      .query('SELECT TOP 1 PasswordHash FROM dbo.Users WHERE UserID=@UserID');

    if (!rs.recordset.length) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    }

    const currentHash = String(rs.recordset[0].PasswordHash || '').trim();
    const ok = await bcrypt.compare(currentPassword, currentHash);
    if (!ok) return res.status(401).json({ message: 'Mật khẩu hiện tại không đúng' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.request()
      .input('UserID', sql.Int, userId)
      .input('PasswordHash', sql.NVarChar(255), newHash)
      .query(`
        UPDATE dbo.Users 
        SET PasswordHash=@PasswordHash, UpdatedAt=SYSDATETIME()
        WHERE UserID=@UserID
      `);

    return res.json({ message: 'Đổi mật khẩu thành công' });
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi đổi mật khẩu', error: err.message });
  }
};

/* ============ Forgot password (OTP) – DEV DEMO ============ */
const _resetStore = new Map();

/** POST /api/auth/request-reset { identifier } */
exports.requestReset = async (req, res) => {
  const identifierRaw = (req.body?.identifier ?? '').toString().trim();
  if (!identifierRaw) return res.status(400).json({ message: 'Thiếu identifier' });

  const isEmail = /\S+@\S+\.\S+/.test(identifierRaw);
  const identifier = isEmail ? identifierRaw.toLowerCase() : identifierRaw;

  try {
    const pool = await poolPromise;
    await pool.request()
      .input('Identifier', sql.NVarChar(256), identifier)
      .query(`
        SELECT TOP 1 UserID 
        FROM dbo.Users 
        WHERE (CASE WHEN @Identifier LIKE '%@%' THEN Email ELSE Email END) = @Identifier
           OR Phone = @Identifier
      `);
  } catch (_) {}

  const code = Math.floor(100000 + Math.random()*900000).toString();
  _resetStore.set(identifier, { code, exp: Date.now() + 10*60*1000 });

  console.log('[OTP] for', identifierRaw, '=>', code);

  return res.json({
    message: 'Đã gửi mã OTP (dev: xem console server)',
    ...(process.env.NODE_ENV !== 'production' && { devOtp: code })
  });
};

exports.verifyReset = (req, res) => {
  const identifierRaw = (req.body?.identifier ?? '').toString().trim();
  const isEmail = /\S+@\S+\.\S+/.test(identifierRaw);
  const key = (isEmail ? identifierRaw.toLowerCase() : identifierRaw);
  const code = (req.body?.code ?? '').toString().trim();

  const rec = _resetStore.get(key);
  if (!rec || rec.exp < Date.now() || rec.code !== code) {
    return res.status(400).json({ message: 'Mã không hợp lệ/đã hết hạn' });
  }
  return res.json({ message: 'Mã hợp lệ' });
};

exports.confirmReset = async (req, res) => {
  const identifierRaw = (req.body?.identifier ?? '').toString().trim();
  const isEmail = /\S+@\S+\.\S+/.test(identifierRaw);
  const key = (isEmail ? identifierRaw.toLowerCase() : identifierRaw);

  const code = (req.body?.code ?? '').toString().trim();
  const newPassword = (req.body?.newPassword ?? '').toString();

  const rec = _resetStore.get(key);
  if (!rec || rec.exp < Date.now() || rec.code !== code) {
    return res.status(400).json({ message: 'Mã không hợp lệ/đã hết hạn' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ message: 'Mật khẩu mới tối thiểu 6 ký tự' });
  }

  try {
    const hash = await bcrypt.hash(newPassword, 10);
    const pool = await poolPromise;
    const upd = await pool.request()
      .input('Identifier',   sql.NVarChar(256), key)
      .input('PasswordHash', sql.NVarChar(255), hash)
      .query(`
        UPDATE dbo.Users
        SET PasswordHash=@PasswordHash, UpdatedAt=SYSDATETIME()
        WHERE (Email = @Identifier COLLATE Latin1_General_CI_AS OR Phone = @Identifier)
      `);

    if (upd.rowsAffected?.[0] === 0) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    }

    _resetStore.delete(key);
    return res.json({ message: 'Đổi mật khẩu thành công' });
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi đặt lại mật khẩu', error: err.message });
  }
};
