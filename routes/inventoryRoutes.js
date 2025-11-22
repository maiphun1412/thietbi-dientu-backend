// routes/inventoryRoutes.js
// Liệt kê tồn kho theo BIẾN THỂ (ProductOptions) và tóm tắt theo SẢN PHẨM
// Yêu cầu: đã có getPool, sql trong ../config/db

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');

/**
 * GET /api/inventory/low-options
 * Liệt kê TẤT CẢ biến thể có stock < threshold (mặc định 10)
 * Query:
 *   - threshold?: number (default 10)
 *   - categoryId?: number (lọc theo ngành hàng, tùy chọn)
 *
 * Trả về:
 * [
 *   { ProductID, ProductName, OptionID, Size, Color, Stock }
 * ]
 */
router.get('/low-options', async (req, res) => {
  const threshold = Number(req.query.threshold ?? 10);
  const categoryId = req.query.categoryId != null ? Number(req.query.categoryId) : null;

  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('threshold', sql.Int, Number.isFinite(threshold) ? threshold : 10)
      .input('categoryId', sql.Int, categoryId)
      .query(`
        SELECT  po.ProductID,
                p.Name AS ProductName,
                po.OptionID,
                po.Size,
                po.Color,
                COALESCE(po.Stock, 0) AS Stock
        FROM dbo.ProductOptions po
        JOIN dbo.Products p ON p.ProductID = po.ProductID
        WHERE COALESCE(po.Stock, 0) < @threshold
          AND COALESCE(po.IsActive, 1) = 1
          AND COALESCE(p.IsActive, 1)  = 1
          AND (@categoryId IS NULL OR p.CategoryID = @categoryId)
        ORDER BY po.Stock ASC, p.ProductID, po.OptionID
      `);

    res.json(r.recordset);
  } catch (err) {
    console.error('GET /inventory/low-options error:', err);
    res.status(500).json({ message: 'Failed to fetch low options', error: String(err) });
  }
});

/**
 * GET /api/inventory/low-summary
 * Tóm tắt theo SẢN PHẨM: có bao nhiêu biến thể < threshold, và mức stock thấp nhất
 * Query:
 *   - threshold?: number (default 10)
 *   - categoryId?: number (tùy chọn)
 *
 * Trả về:
 * [
 *   { ProductID, Name, LowOptionCount, MinStock }
 * ]
 */
router.get('/low-summary', async (req, res) => {
  const threshold = Number(req.query.threshold ?? 10);
  const categoryId = req.query.categoryId != null ? Number(req.query.categoryId) : null;

  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('threshold', sql.Int, Number.isFinite(threshold) ? threshold : 10)
      .input('categoryId', sql.Int, categoryId)
      .query(`
        SELECT  p.ProductID,
                p.Name,
                SUM(CASE WHEN COALESCE(po.Stock, 0) < @threshold THEN 1 ELSE 0 END) AS LowOptionCount,
                MIN(COALESCE(po.Stock, 0))                                         AS MinStock
        FROM dbo.ProductOptions po
        JOIN dbo.Products p ON p.ProductID = po.ProductID
        WHERE COALESCE(po.IsActive, 1) = 1
          AND COALESCE(p.IsActive, 1)  = 1
          AND (@categoryId IS NULL OR p.CategoryID = @categoryId)
        GROUP BY p.ProductID, p.Name
        HAVING MIN(COALESCE(po.Stock, 0)) < @threshold
        ORDER BY MinStock ASC, LowOptionCount DESC
      `);

    res.json(r.recordset);
  } catch (err) {
    console.error('GET /inventory/low-summary error:', err);
    res.status(500).json({ message: 'Failed to fetch low summary', error: String(err) });
  }
});

/**
 * GET /api/inventory/product-summary
 * Tóm tắt tồn theo SẢN PHẨM (dựa trên toàn bộ biến thể):
 *  - MinStock: tồn nhỏ nhất trong các biến thể
 *  - TotalStock: tổng tồn của các biến thể
 *  - OutCount: số biến thể hết hàng (<=0)
 *  - LowCount: số biến thể sắp hết (0 < stock < threshold)
 *  - Severity: 3=đỏ đậm (có biến thể hết), 2=đỏ nhạt (min<red), 1=vàng (min<threshold), 0=xanh
 *
 * Query:
 *  - threshold?: number (mặc định 10 — ngưỡng vàng)
 *  - red?: number (mặc định 3 — ngưỡng đỏ nhạt)
 *  - categoryId?: number (tùy chọn)
 *
 * Trả về:
 * [
 *   { ProductID, ProductName, MinStock, TotalStock, OutCount, LowCount, Severity }
 * ]
 */
router.get('/product-summary', async (req, res) => {
  const threshold = Number(req.query.threshold ?? 10);
  const red = Number(req.query.red ?? 3);
  const categoryId = req.query.categoryId != null ? Number(req.query.categoryId) : null;

  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('TH', sql.Int, Number.isFinite(threshold) ? threshold : 10)
      .input('RD', sql.Int, Number.isFinite(red) ? red : 3)
      .input('categoryId', sql.Int, categoryId)
      .query(`
        SELECT
          p.ProductID,
          p.Name AS ProductName,
          MIN(COALESCE(o.Stock, 0)) AS MinStock,
          SUM(COALESCE(o.Stock, 0)) AS TotalStock,
          SUM(CASE WHEN COALESCE(o.Stock, 0) <= 0 THEN 1 ELSE 0 END) AS OutCount,
          SUM(CASE WHEN COALESCE(o.Stock, 0) > 0 AND COALESCE(o.Stock, 0) < @TH THEN 1 ELSE 0 END) AS LowCount,
          MAX(
            CASE
              WHEN COALESCE(o.Stock, 0) <= 0 THEN 3          -- đỏ đậm (hết)
              WHEN COALESCE(o.Stock, 0) < @RD THEN 2         -- đỏ nhạt (1..2)
              WHEN COALESCE(o.Stock, 0) < @TH THEN 1         -- vàng (3..9)
              ELSE 0                                         -- xanh (>=TH)
            END
          ) AS Severity
        FROM dbo.ProductOptions o
        JOIN dbo.Products p ON p.ProductID = o.ProductID
        WHERE COALESCE(o.IsActive, 1) = 1
          AND COALESCE(p.IsActive, 1)  = 1
          AND (@categoryId IS NULL OR p.CategoryID = @categoryId)
        GROUP BY p.ProductID, p.Name
        ORDER BY Severity DESC, MinStock ASC, p.ProductID
      `);

    res.json(r.recordset);
  } catch (err) {
    console.error('GET /inventory/product-summary error:', err);
    res.status(500).json({ message: 'Failed to fetch product summary', error: String(err) });
  }
});

module.exports = router;

/*
— Cách gắn route (trong app.js):
   const inventoryRoutes = require('./routes/inventoryRoutes');
   app.use('/api/inventory', inventoryRoutes);

— Ví dụ gọi:
   GET /api/inventory/low-options?threshold=10
   GET /api/inventory/low-summary?threshold=10&categoryId=4
   GET /api/inventory/product-summary?threshold=10&red=3&categoryId=4
*/
