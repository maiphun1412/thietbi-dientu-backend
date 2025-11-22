const { getPool, sql } = require('./config/db');
const bcrypt = require('bcryptjs');

(async () => {
  try {
    const pool = await getPool();

    const hash = await bcrypt.hash('123456', 10);

    await pool.request()
      .input('Email', sql.NVarChar, 'admin@mail.tech')
      .input('PasswordHash', sql.NVarChar, hash)
      .input('FullName', sql.NVarChar, 'Admin')
      .input('Phone', sql.NVarChar, '0900000000')
      .input('Role', sql.NVarChar, 'admin')
      .query(`
        INSERT INTO Users (Email, PasswordHash, FullName, Phone, IsActive, Role, CreatedAt)
        VALUES (@Email, @PasswordHash, @FullName, @Phone, 1, @Role, GETDATE())
      `);

    console.log('✅ Seed admin thành công!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed lỗi:', err);
    process.exit(1);
  }
})();
