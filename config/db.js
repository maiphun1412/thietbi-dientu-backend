// config/db.js
require('dotenv').config();

// Luôn dùng driver ODBC: msnodesqlv8
const msnodesqlv8 = require('mssql/msnodesqlv8');

// 🔒 ÉP TẤT CẢ require('mssql') TRONG ỨNG DỤNG TRẢ VỀ msnodesqlv8
try {
  const mssqlModuleId = require.resolve('mssql');
  // Ghi đè cache export của 'mssql' = msnodesqlv8 để mọi nơi dùng chung một driver
  require.cache[mssqlModuleId] = {
    id: mssqlModuleId,
    filename: mssqlModuleId,
    loaded: true,
    exports: msnodesqlv8,
  };
} catch (_) {
  // ignore – phòng trường hợp không resolve được
}

// Từ đây trở đi, 'sql' chính là instance msnodesqlv8, và các file lỡ require('mssql') cũng nhận msnodesqlv8
const sql = msnodesqlv8;

let pool;
let poolPromise;

async function _connect() {
  if (pool) return pool;
  if (poolPromise) {
    pool = await poolPromise;
    return pool;
  }

  const csEnv = (process.env.DB_CONNECTION_STRING || '').trim();
  const altCs = (process.env.SQLSERVER_URL || '').trim();
  const connectionString = csEnv || altCs;

  try {
    if (connectionString) {
      console.log('DB connecting via msnodesqlv8 + connectionString …');
      // ✅ Kết nối bằng chính instance driver (không tạo new ConnectionPool “nhầm” base)
      poolPromise = sql.connect({ driver: 'msnodesqlv8', connectionString });
      pool = await poolPromise;
      console.log('✅ Connected to SQL Server (ODBC string)');
      return pool;
    }

    // Fallback: cấu hình rời rạc (Windows Auth)
    const server       = process.env.DB_SERVER   || 'LAPTOP-VDKBJUCL';
    const database     = process.env.DB_NAME     || 'Thietbidientu';
    const instanceName = (process.env.DB_INSTANCE || '').trim() || undefined;
    const portEnv      = process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined;

    const cfg = {
      server,
      database,
      driver: 'msnodesqlv8',
      ...(instanceName ? {} : (portEnv ? { port: portEnv } : {})),
      options: {
        trustedConnection: true,
        trustServerCertificate: (process.env.SQL_TRUST_SERVER_CERTIFICATE || 'true') === 'true',
        encrypt: (process.env.SQL_ENCRYPT || 'false') === 'true',
        instanceName,
      },
      connectionTimeout: Number(process.env.DB_CONN_TIMEOUT || 15000),
      requestTimeout: Number(process.env.DB_REQ_TIMEOUT || 15000),
      pool: {
        max: Number(process.env.DB_POOL_MAX || 10),
        min: Number(process.env.DB_POOL_MIN || 0),
        idleTimeoutMillis: Number(process.env.DB_POOL_IDLE || 30000),
      },
    };

    console.log('DB connecting via msnodesqlv8 object config:', {
      server,
      database,
      instanceName: instanceName || null,
      port: cfg.port || null,
    });

    // ✅ Vẫn dùng sql.connect để đảm bảo cùng instance
    poolPromise = sql.connect(cfg);
    pool = await poolPromise;

    console.log('✅ Connected to SQL Server (Windows Auth/msnodesqlv8)');
    return pool;
  } catch (err) {
    console.error('❌ DB connect error:');
    console.dir(err, { depth: 6 });
    throw err;
  }
}

async function getPool() {
  return await _connect();
}

poolPromise = _connect();

module.exports = {
  // Export driver đồng nhất
  sql,
  mssql: sql,

  getPool,
  poolPromise,

  get pool() {
    return pool;
  },
};
