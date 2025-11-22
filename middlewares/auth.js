'use strict';

const jwt = require('jsonwebtoken');

/**
 * Ký JWT (thời hạn 7 ngày)
 * Dùng chung JWT_SECRET đã có trong .env
 */
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Lấy JWT:
 *  - Ưu tiên header "Authorization: Bearer <token>"
 *  - Fallback: cookie "accessToken"
 *  - Fallback khác (tùy chọn): query ?token=
 */
function getTokenFromRequest(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (h && typeof h === 'string') {
    // Chuẩn: "Bearer <token>"
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m && m[1]) return m[1].trim();

    // Cũng hỗ trợ dạng "Bearer    xxx"
    const [scheme, token] = h.split(/\s+/);
    if (scheme?.toLowerCase() === 'bearer' && token) return token.trim();
  }
  if (req.cookies?.accessToken) return req.cookies.accessToken;
  if (req.query?.token) return String(req.query.token);
  return null;
}

/**
 * Chuẩn hoá userId từ payload (hỗ trợ: id | userId | UserId | UserID)
 * Trả về số (Number) hoặc null nếu không hợp lệ.
 */
function normalizeUserId(decoded) {
  const raw =
    decoded?.userId ??
    decoded?.UserId ??
    decoded?.UserID ??
    decoded?.id;

  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Helper: verify token cho các luồng ngoài Express (ví dụ: Socket.IO).
 * Trả về: { ok:true, payload, userId } hoặc { ok:false, error }
 */
function decodeToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = normalizeUserId(payload);
    if (userId == null) {
      return { ok: false, error: 'token has no user id' };
    }
    return { ok: true, payload, userId };
  } catch (err) {
    return { ok: false, error: err?.message || 'invalid token' };
  }
}

/**
 * Helper: lấy nhanh userId từ token (dùng cho Socket.IO)
 */
function getUserIdFromToken(token) {
  const r = decodeToken(token);
  return r.ok ? r.userId : null;
}

/**
 * auth: Xác thực người dùng từ JWT.
 * - Gắn req.user với cả { userId, id } để tương thích mọi nơi
 * - Trả 401 nếu thiếu token / token hết hạn / payload không có user id
 */
const auth = (req, res, next) => {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ message: 'Unauthorized: missing bearer token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = normalizeUserId(decoded);
    if (userId == null) {
      return res.status(401).json({ message: 'Unauthorized: token has no user id' });
    }

    // Chuẩn hoá: luôn có cả id và userId
    req.user = { ...decoded, id: userId, userId };
    res.locals.user = req.user; // tiện cho debug/templating
    next();
  } catch (err) {
    if (err?.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Unauthorized: jwt expired' });
    }
    return res.status(401).json({
      message: `Unauthorized: ${err?.message || 'invalid token'}`
    });
  }
};

/**
 * requireRole: kiểm tra quyền theo role.
 * - Nhận 1 role hoặc nhiều role; hỗ trợ requireRole('admin','customer') hoặc requireRole(['admin','customer'])
 * - So khớp không phân biệt hoa-thường.
 */
const requireRole =
  (...accepted) =>
  (req, res, next) => {
    const roles = Array.isArray(accepted[0]) ? accepted[0] : accepted;
    const want = roles.map((r) => String(r).toLowerCase());

    const current = (req.user?.role ? String(req.user.role) : '').toLowerCase();
    if (!current) {
      return res.status(403).json({ message: 'Forbidden: no role on user' });
    }
    if (!want.includes(current)) {
      return res.status(403).json({ message: 'Forbidden: insufficient role' });
    }
    next();
  };

// Alias để tương thích với tài liệu mục 2.3
const authRequired = auth;

module.exports = {
  // ký JWT
  signToken,
  // middleware xác thực
  auth,            // giữ tên cũ
  authRequired,    // tên theo tài liệu 2.3
  // guard phân quyền
  requireRole,
  // utils lấy token
  getTokenFromRequest,
  getTokenFromHeader: getTokenFromRequest,

  // helpers thêm (không ảnh hưởng code cũ)
  decodeToken,
  getUserIdFromToken,
};
