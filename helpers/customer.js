// helpers/customer.js
const db = require('../config/db');
const sql = db.sql;
const poolPromise = db.poolPromise;

/** Trả về CustomerID cho user; nếu chưa có thì tự tạo rồi trả về */
exports.ensureCustomerForUser = async function ensureCustomerForUser(userId) {
  const pool = await poolPromise;

  // đã có chưa?
  const rs = await pool.request()
    .input('UserID', sql.Int, userId)
    .query(`SELECT TOP 1 CustomerID FROM dbo.Customers WHERE UserID=@UserID`);
  if (rs.recordset[0]?.CustomerID) return rs.recordset[0].CustomerID;

  // lấy info user để copy
  const ru = await pool.request()
    .input('UserID', sql.Int, userId)
    .query(`SELECT TOP 1 FullName, Phone FROM dbo.Users WHERE UserID=@UserID`);
  const fullName = ru.recordset[0]?.FullName || '';
  const phone    = ru.recordset[0]?.Phone || null;

  const ins = await pool.request()
    .input('UserID',   sql.Int, userId)
    .input('FullName', sql.NVarChar(255), fullName)
    .input('Phone',    sql.NVarChar(50),  phone)
    .query(`
      INSERT INTO dbo.Customers (UserID, FullName, Phone, CreatedAt)
      OUTPUT inserted.CustomerID AS CustomerID
      VALUES (@UserID, @FullName, @Phone, SYSDATETIME())
    `);

  return ins.recordset[0].CustomerID;
};
