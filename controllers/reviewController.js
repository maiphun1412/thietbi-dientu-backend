// controllers/reviewController.js
const path = require('path');
const db = require('../utils/dbAccess');
const { sql } = db;

/* ------------------------- Helpers ------------------------- */
function buildImagesTVP(images = []) {
  const tvp = new sql.Table('dbo.TT_ReviewImageList');
  tvp.columns.add('ImageUrl', sql.NVarChar(400), { nullable: false });
  (images || []).forEach(u => {
    if (typeof u === 'string' && u.trim()) tvp.rows.add(u.trim());
  });
  return tvp;
}

function fileToUrl(f) {
  const filename = path.basename(f.path);
  return `/uploads/reviews/${filename}`;
}

function toAbsUrl(u) {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  const base = process.env.BASE_URL || '';
  return `${base}${u}`;
}

const isDelivered = (s = '') => {
  const u = String(s || '').trim().toUpperCase();
  return (
    u.includes('COMPLETED') ||
    u.includes('DELIVERED') ||
    u.includes('ĐÃ GIAO') ||
    u.includes('DA GIAO')
  );
};

/** Tự động phát hiện cột khách hàng trong Orders (CustomerID/UserID/AccountID) */
async function getCustomerColumn(pool, tableName) {
  const prefer = ['CustomerID', 'UserID', 'AccountID'];
  const r = await pool.request().query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='${tableName}'
  `);
  const cols = new Set(r.recordset.map(x => x.COLUMN_NAME));
  for (const c of prefer) if (cols.has(c)) return c;
  return 'CustomerID';
}

/* ------------------------- Core logic ------------------------- */
/** Lấy thông tin order-item + kiểm tra quyền review (đơn thuộc user + đã giao) */
async function canReviewByOrderItemId(pool, tokenUserId, orderItemId) {
  const custCol = await getCustomerColumn(pool, 'Orders');
  const rs = await pool
    .request()
    .input('oi', sql.Int, orderItemId)
    .input('uid', sql.Int, tokenUserId)
    .query(`
      SELECT TOP 1
        oi.OrderItemID,
        oi.ProductID,
        o.${custCol} AS CustomerID,
        o.Status      AS OrderStatus,
        s.Status      AS ShipStatus
      FROM dbo.OrderItems oi
      JOIN dbo.Orders o      ON o.OrderID = oi.OrderID
      LEFT JOIN dbo.Shipments s ON s.OrderID = o.OrderID
      WHERE oi.OrderItemID = @oi AND o.${custCol} = @uid
    `);

  if (!rs.recordset.length) return { ok: false, reason: 'NOT_FOUND' };
  const row = rs.recordset[0];
  const ok = isDelivered(row.OrderStatus) || isDelivered(row.ShipStatus);
  return { ok, row };
}

/* ------------------------- APIs ------------------------- */
exports.getProductReviews = async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (!productId) return res.status(400).json({ message: 'productId invalid' });

  try {
    const pool = await db.getPool();
    const r = await pool
      .request()
      .input('ProductID', sql.Int, productId)
      .execute('dbo.sp_GetProductReviews');

    const reviews = r.recordsets?.[0] ?? [];
    const images  = r.recordsets?.[1] ?? [];
    const stats   = r.recordsets?.[2]?.[0] || { TotalReviews: 0, AvgRating: 0 };

    const map = {};
    images.forEach(i => { (map[i.ReviewID] ||= []).push(toAbsUrl(i.ImageUrl)); });
    reviews.forEach(rv => rv.images = map[rv.ReviewID] || []);

    res.json({ reviews, stats });
  } catch (e) {
    console.error('getProductReviews', e);
    res.status(500).json({ message: String(e) });
  }
};

exports.canReview = async (req, res) => {
  const productId  = parseInt(req.params.productId, 10);
  const tokenUserId = req.user?.id ?? req.user?.userId ?? req.user?.UserID ?? null;

  if (!productId)  return res.status(400).json({ message: 'productId invalid' });
  if (!tokenUserId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const pool = await db.getPool();
    // Giữ nguyên proc nếu bạn đang dùng – không đổi
    const r = await pool
      .request()
      .input('ProductID',  sql.Int, productId)
      .input('CustomerID', sql.Int, tokenUserId)
      .execute('dbo.sp_CanReview');

    res.json({ orderItemIds: (r.recordset || []).map(x => x.OrderItemID) });
  } catch (e) {
    console.error('canReview', e);
    res.status(500).json({ message: String(e) });
  }
};

/** Thêm đánh giá – dùng đúng CustomerID từ đơn hàng (tránh lỗi FK) */
exports.addReview = async (req, res) => {
  const body = req.body || {};
  const tokenUserId = req.user?.id ?? req.user?.userId ?? req.user?.UserID ?? null;
  const orderItemId = Number(body.orderItemId || body.OrderItemID);
  const rating      = Number(body.rating || body.Rating);
  const comment     = body.comment ?? body.Comment ?? null;

  if (!tokenUserId) return res.status(401).json({ message: 'Unauthorized' });
  if (!orderItemId || !rating)
    return res.status(400).json({ message: 'orderItemId and rating are required' });

  let imageUrls = [];
  if (Array.isArray(req.files) && req.files.length)
    imageUrls = req.files.map(fileToUrl);
  else if (Array.isArray(body.images))
    imageUrls = body.images.filter(u => typeof u === 'string' && u.trim());

  const pool = await db.getPool();

  // 1) Kiểm tra quyền + lấy đúng CustomerID từ đơn
  const check = await canReviewByOrderItemId(pool, tokenUserId, orderItemId);
  if (!check.ok) {
    return res.status(400).json({
      message: 'Đơn này chưa đủ điều kiện đánh giá (chưa giao hoặc không thuộc tài khoản).'
    });
  }
  const customerIdToUse = check.row.CustomerID; // <- ID chắc chắn tồn tại và đúng FK

  try {
    // 2) Gọi proc thêm review
    const execRes = await pool
      .request()
      .input('OrderItemID', sql.Int, orderItemId)
      .input('CustomerID', sql.Int, customerIdToUse)
      .input('Rating',     sql.TinyInt, rating)
      .input('Comment',    sql.NVarChar(sql.MAX), comment)
      .execute('dbo.sp_AddReview');

    let reviewId = execRes?.recordset?.[0]?.ReviewID ?? null;
    if (!reviewId) {
      const q = await pool.request()
        .input('OrderItemID', sql.Int, orderItemId)
        .query(`SELECT TOP 1 ReviewID FROM dbo.Reviews WHERE OrderItemID=@OrderItemID ORDER BY CreatedAt DESC`);
      reviewId = q.recordset?.[0]?.ReviewID ?? null;
    }
    if (!reviewId) throw new Error('Không lấy được ReviewID sau khi tạo review');

    // 3) Nếu có ảnh, thêm ảnh trong transaction
    if (imageUrls.length) {
      const tx = new sql.Transaction(pool);
      await tx.begin();
      for (const url of imageUrls) {
        await tx.request()
          .input('ReviewID', sql.Int, reviewId)
          .input('ImageUrl', sql.NVarChar(400), url)
          .query(`INSERT INTO dbo.ReviewImages (ReviewID, ImageUrl, CreatedAt)
                  VALUES (@ReviewID, @ImageUrl, GETDATE())`);
      }
      await tx.commit();
    }

    res.json({ reviewId, images: imageUrls });
  } catch (e) {
    console.error('addReview SQL ERROR:', e?.originalError || e);
    res.status(500).json({ message: 'Internal Server Error', error: String(e) });
  }
};

/* ------------------------- update/delete ------------------------- */
exports.updateReview = async (req, res) => {
  const reviewId = parseInt(req.params.reviewId, 10);
  const { rating, comment } = req.body;
  const tokenUserId = req.user?.id ?? req.user?.userId ?? req.user?.UserID ?? null;

  if (!reviewId)     return res.status(400).json({ message: 'reviewId invalid' });
  if (!tokenUserId)  return res.status(401).json({ message: 'Unauthorized' });

  try {
    const pool = await db.getPool();
    // Lấy CustomerID của review để chắc chắn đúng FK (và kiểm tra quyền)
    const cur = await pool.request()
      .input('rid', sql.Int, reviewId)
      .query(`SELECT r.CustomerID, oi.OrderID
              FROM dbo.Reviews r
              LEFT JOIN dbo.OrderItems oi ON oi.OrderItemID = r.OrderItemID
              WHERE r.ReviewID=@rid`);
    if (!cur.recordset[0]) return res.status(404).json({ message: 'Review not found' });

    const customerIdToUse = cur.recordset[0].CustomerID;

    await pool
      .request()
      .input('ReviewID',   sql.Int, reviewId)
      .input('CustomerID', sql.Int, customerIdToUse)
      .input('Rating',     sql.TinyInt, rating ?? null)
      .input('Comment',    sql.NVarChar(sql.MAX), comment ?? null)
      .execute('dbo.sp_UpdateReview');

    res.json({ ok: true });
  } catch (e) {
    console.error('updateReview', e);
    res.status(500).json({ message: String(e) });
  }
};

exports.deleteReview = async (req, res) => {
  const reviewId = parseInt(req.params.reviewId, 10);
  const tokenUserId = req.user?.id ?? req.user?.userId ?? req.user?.UserID ?? null;

  if (!reviewId)    return res.status(400).json({ message: 'reviewId invalid' });
  if (!tokenUserId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const pool = await db.getPool();
    // Lấy CustomerID của review để gửi đúng vào proc
    const cur = await pool.request()
      .input('rid', sql.Int, reviewId)
      .query(`SELECT CustomerID FROM dbo.Reviews WHERE ReviewID=@rid`);
    if (!cur.recordset[0]) return res.status(404).json({ message: 'Review not found' });

    const customerIdToUse = cur.recordset[0].CustomerID;

    await pool
      .request()
      .input('ReviewID',   sql.Int, reviewId)
      .input('CustomerID', sql.Int, customerIdToUse)
      .execute('dbo.sp_DeleteReview');

    res.json({ ok: true });
  } catch (e) {
    console.error('deleteReview', e);
    res.status(500).json({ message: String(e) });
  }
};
