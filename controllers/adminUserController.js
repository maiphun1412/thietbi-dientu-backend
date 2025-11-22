// controllers/adminUserController.js
const { getPool, sql } = require('../config/db');

// GET /api/admin/users?q=...
const listUsers = async (req, res) => {
  const keyword = (req.query.q || '').trim();

  try {
    const pool = await getPool();
    const request = pool.request();

    let query = `
      SELECT UserID, Email, FullName, Phone,
             IsActive, CreatedAt, UpdatedAt, Role, BanReason
      FROM Users
    `;

    if (keyword) {
      query += `
        WHERE Email LIKE @kw
           OR FullName LIKE @kw
           OR Phone LIKE @kw
      `;
      request.input('kw', sql.NVarChar, `%${keyword}%`);
    }

    query += ' ORDER BY CreatedAt DESC';

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error('listUsers error:', err);
    res.status(500).json({ message: 'Lỗi khi lấy danh sách người dùng', error: err.message });
  }
};

// GET /api/admin/users/:id
const getUserDetail = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'UserID không hợp lệ' });

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('UserID', sql.Int, id)
      .query(`
        SELECT UserID, Email, FullName, Phone,
               IsActive, CreatedAt, UpdatedAt, Role, BanReason
        FROM Users
        WHERE UserID = @UserID
      `);

    const user = result.recordset[0];
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }

    res.json(user);
  } catch (err) {
    console.error('getUserDetail error:', err);
    res.status(500).json({ message: 'Lỗi khi lấy chi tiết người dùng', error: err.message });
  }
};

// PUT /api/admin/users/:id/ban
// body: { isActive: bool, reason?: string }
const updateUserBanStatus = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { isActive, reason } = req.body;

  if (!id) return res.status(400).json({ message: 'UserID không hợp lệ' });
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ message: 'isActive phải là true/false' });
  }

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('UserID', sql.Int, id)
      .input('IsActive', sql.Bit, isActive ? 1 : 0)
      .input('BanReason', sql.NVarChar, isActive ? null : (reason || null))
      .query(`
        UPDATE Users
        SET IsActive = @IsActive,
            BanReason = @BanReason,
            UpdatedAt = GETDATE()
        WHERE UserID = @UserID;

        SELECT UserID, Email, FullName, Phone,
               IsActive, CreatedAt, UpdatedAt, Role, BanReason
        FROM Users
        WHERE UserID = @UserID;
      `);

    const updated = result.recordset[0];
    if (!updated) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng để cập nhật' });
    }

    res.json(updated);
  } catch (err) {
    console.error('updateUserBanStatus error:', err);
    res.status(500).json({ message: 'Lỗi khi cập nhật trạng thái người dùng', error: err.message });
  }
};

// PUT /api/admin/users/:id/role
// body: { role: 'customer' | 'shipper' | 'admin' }
const updateUserRole = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = (req.body.role || '').toString().toLowerCase();

  if (!id) return res.status(400).json({ message: 'UserID không hợp lệ' });

  const allowedRoles = ['customer', 'shipper', 'admin'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ message: 'Role không hợp lệ' });
  }

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('UserID', sql.Int, id)
      .input('Role', sql.NVarChar, role)
      .query(`
        UPDATE Users
        SET Role = @Role,
            UpdatedAt = GETDATE()
        WHERE UserID = @UserID;

        SELECT UserID, Email, FullName, Phone,
               IsActive, CreatedAt, UpdatedAt, Role, BanReason
        FROM Users
        WHERE UserID = @UserID;
      `);

    const updated = result.recordset[0];
    if (!updated) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng để cập nhật role' });
    }

    res.json(updated);
  } catch (err) {
    console.error('updateUserRole error:', err);
    res.status(500).json({ message: 'Lỗi khi cập nhật role người dùng', error: err.message });
  }
};

module.exports = {
  listUsers,
  getUserDetail,
  updateUserBanStatus,
  updateUserRole,
};
