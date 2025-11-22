require('dotenv').config();
const sql = require('mssql/msnodesqlv8');

(async () => {
  try {
    const cs = (process.env.DB_CONNECTION_STRING || process.env.SQLSERVER_URL || '').trim();
    console.log('CS =', cs);
    const pool = await new sql.ConnectionPool({
      connectionString: cs,
      driver: 'msnodesqlv8',
      connectionTimeout: 10000,
      requestTimeout: 10000,
    }).connect();

    const r = await pool.request().query('SELECT DB_NAME() AS db, SUSER_SNAME() AS login_name');
    console.log('OK:', r.recordset);
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message, '| inner:', err.originalError?.message || err.originalError);
    process.exit(1);
  }
})();
