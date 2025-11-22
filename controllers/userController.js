const { getPool, sql } = require('../config/db');
const bcrypt = require('bcrypt');

/* ======================
   Users CRUD
====================== */

// Lấy tất cả users (không trả password)
const getAllUsers = async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT UserID, Email, FullName, Phone, Role, IsActive, CreatedAt, UpdatedAt
      FROM Users
    `);
    return res.json(result.recordset);
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi khi lấy người dùng', error: err.message });
  }
};

// Lấy user theo ID
const getUserById = async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('UserID', sql.Int, id)
      .query(`
        SELECT UserID, Email, FullName, Phone, Role, IsActive, CreatedAt, UpdatedAt
        FROM Users WHERE UserID = @UserID
      `);
    return res.json(result.recordset[0] || {});
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi khi lấy người dùng', error: err.message });
  }
};

// Đăng ký (add user) – có check trùng email
const registerUser = async (req, res) => {
  const { Email, Password, FullName, Phone, Role } = req.body;

  if (!Email || !Password || !FullName) {
    return res.status(400).json({ message: 'Email, Password và FullName là bắt buộc' });
  }

  try {
    const pool = await getPool();

    // Kiểm tra trùng email
    const existed = await pool.request()
      .input('Email', sql.NVarChar, Email)
      .query('SELECT 1 FROM Users WHERE Email = @Email');
    if (existed.recordset.length) {
      return res.status(409).json({ message: 'Email đã tồn tại' });
    }

    const hashed = await bcrypt.hash(Password, 10);

    const insert = await pool.request()
      .input('Email', sql.NVarChar, Email)
      .input('PasswordHash', sql.NVarChar, hashed)
      .input('FullName', sql.NVarChar, FullName)
      .input('Phone', sql.NVarChar, Phone || null)
      .input('Role', sql.NVarChar, Role || 'customer') // mặc định là customer
      .query(`
        INSERT INTO Users (Email, PasswordHash, FullName, Phone, Role, IsActive, CreatedAt, UpdatedAt)
        OUTPUT INSERTED.UserID
        VALUES (@Email, @PasswordHash, @FullName, @Phone, @Role, 1, GETDATE(), GETDATE())
      `);

    const newId = insert.recordset[0]?.UserID;

    return res.status(201).json({
      message: 'Đăng ký thành công',
      user: { UserID: newId, Email, FullName, Phone, Role: Role || 'customer' }
    });
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi khi thêm người dùng', error: err.message });
  }
};

// Cập nhật user
const updateUser = async (req, res) => {
  const { id } = req.params;
  const { Email, Password, FullName, Phone, Role, IsActive } = req.body;

  try {
    const pool = await getPool();

    let hashedPassword = null;
    if (Password) {
      hashedPassword = await bcrypt.hash(Password, 10);
    }

    // Nếu có đổi email, check trùng
    if (Email) {
      const dup = await pool.request()
        .input('Email', sql.NVarChar, Email)
        .input('UserID', sql.Int, id)
        .query('SELECT 1 FROM Users WHERE Email = @Email AND UserID <> @UserID');
      if (dup.recordset.length) {
        return res.status(409).json({ message: 'Email đã được sử dụng' });
      }
    }

    const query = `
      UPDATE Users SET
        ${Email != null ? 'Email = @Email,' : ''}
        ${hashedPassword ? 'PasswordHash = @PasswordHash,' : ''}
        ${FullName != null ? 'FullName = @FullName,' : ''}
        ${Phone != null ? 'Phone = @Phone,' : ''}
        ${Role != null ? 'Role = @Role,' : ''}
        IsActive = @IsActive,
        UpdatedAt = GETDATE()
      WHERE UserID = @UserID
    `;

    const request = pool.request()
      .input('UserID', sql.Int, id)
      .input('IsActive', sql.Bit, IsActive ?? 1);

    if (Email != null) request.input('Email', sql.NVarChar, Email);
    if (FullName != null) request.input('FullName', sql.NVarChar, FullName);
    if (Phone != null) request.input('Phone', sql.NVarChar, Phone);
    if (Role != null) request.input('Role', sql.NVarChar, Role);
    if (hashedPassword) request.input('PasswordHash', sql.NVarChar, hashedPassword);

    await request.query(query);

    return res.json({ message: 'Cập nhật người dùng thành công' });
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi khi cập nhật người dùng', error: err.message });
  }
};

// Xóa user
const deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await getPool();
    await pool.request()
      .input('UserID', sql.Int, id)
      .query('DELETE FROM Users WHERE UserID = @UserID');
    return res.json({ message: 'Xóa người dùng thành công' });
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi khi xóa người dùng', error: err.message });
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  registerUser,
  updateUser,
  deleteUser,
};
