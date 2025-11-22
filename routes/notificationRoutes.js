// routes/notificationRoutes.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');

// TODO: khi có JWT middleware, thay lấy userId từ req.user.userId
// const auth = require('../middlewares/auth');

// Helper: kiểm tra cột có tồn tại không
async function hasColumn(pool, table, column) {
  const rs = await pool.request()
    .input('table', sql.NVarChar, table)
    .input('column', sql.NVarChar, column)
    .query(`
      SELECT COUNT(*) AS Cnt
      FROM sys.columns
      WHERE object_id = OBJECT_ID(@table) AND name = @column
    `);
  return (rs.recordset[0]?.Cnt || 0) > 0;
}

// GET /api/notifications
router.get('/', /*auth,*/ async (req, res) => {
  try {
    // Tạm test: lấy userId từ query (?userId=123). Khi có JWT thì bỏ dòng dưới.
    const userId = Number(req.query.userId || req.user?.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Missing userId' });

    const pool = await getPool();
    const hasDataJson = await hasColumn(pool, 'dbo.Notifications', 'DataJson');

    const selectCols = hasDataJson
      ? 'NotificationID, Type, Title, Message, DataJson, IsRead, CreatedAt'
      : 'NotificationID, Type, Title, Message, IsRead, CreatedAt';

    const rs = await pool.request()
      .input('UserID', sql.Int, userId)
      .query(`
        SELECT ${selectCols}
        FROM dbo.Notifications
        WHERE UserID=@UserID
        ORDER BY CreatedAt DESC
      `);

    res.json(rs.recordset);
  } catch (err) {
    console.error('[notifications][GET /]', err);
    res.status(500).json({ message: 'Lỗi khi lấy thông báo' });
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', /*auth,*/ async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = Number(req.query.userId || req.user?.userId);
    if (!Number.isFinite(id) || !Number.isFinite(userId)) {
      return res.status(400).json({ message: 'Missing params' });
    }

    const pool = await getPool();
    await pool.request()
      .input('Id', sql.Int, id)
      .input('UserID', sql.Int, userId)
      .query(`
        UPDATE dbo.Notifications
        SET IsRead = 1
        WHERE NotificationID=@Id AND UserID=@UserID
      `);

    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications][POST /:id/read]', err);
    res.status(500).json({ message: 'Lỗi khi đánh dấu đã đọc' });
  }
});

module.exports = router;
