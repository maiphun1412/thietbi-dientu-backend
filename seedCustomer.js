// seedCustomer.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getPool, sql } = require('./config/db');

(async () => {
  try {
    const pool = await getPool();
    const hash = await bcrypt.hash('141200', 10);

    await pool.request()
      .input('FullName', sql.NVarChar, 'User One')
      .input('Email', sql.NVarChar, 'user1@mail.tech')
      .input('PasswordHash', sql.NVarChar, hash)
      .input('Role', sql.NVarChar, 'customer')
      .query(`
        INSERT INTO Users (FullName, Email, PasswordHash, Role, CreatedAt)
        VALUES (@FullName, @Email, @PasswordHash, @Role, GETDATE())
      `);

    console.log('Customer user created!');
    process.exit(0);
  } catch (err) {
    console.error('Error seeding customer:', err);
    process.exit(1);
  }
})();
