// utils/dbAccess.js
// Chuẩn hoá cách lấy pool từ config/db bất kể export tên gì
const raw = require('../config/db');

// Ưu tiên sql từ config, fallback sang mssql mặc định
const sql = raw.sql || raw.mssql || require('mssql');

async function getPool() {
  // Các trường hợp thường gặp
  if (raw.poolPromise) return await raw.poolPromise;            // kiểu Promise
  if (typeof raw.getPool === 'function') return await raw.getPool(); // hàm trả về pool
  if (raw.pool && typeof raw.pool.request === 'function') return raw.pool; // instance
  if (raw.default?.poolPromise) return await raw.default.poolPromise;      // export default

  // In ra keys để debug nếu còn trượt
  console.error('[dbAccess] config/db exports keys =', Object.keys(raw || {}));
  throw new Error('[dbAccess] Cannot resolve DB pool from config/db.');
}

module.exports = { sql, getPool };
