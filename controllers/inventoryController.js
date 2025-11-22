// controllers/inventoryController.js
const { getPool, sql } = require('../config/db');

// GET /api/inventory/product-summary?threshold=10&red=3
exports.getProductSummary = async (req, res) => {
  const th = Number(req.query.threshold ?? 10); // vàng
  const rd = Number(req.query.red ?? 3);       // đỏ nhạt
  try {
    const pool = await getPool();
    const rs = await pool.request()
      .input('TH', sql.Int, th)
      .input('RD', sql.Int, rd)
      .query(`
        SELECT
          p.ProductID,
          p.Name AS ProductName,
          MIN(o.Stock) AS MinStock,
          SUM(o.Stock) AS TotalStock,
          SUM(CASE WHEN o.Stock <= 0 THEN 1 ELSE 0 END) AS OutCount,
          SUM(CASE WHEN o.Stock > 0 AND o.Stock < @TH THEN 1 ELSE 0 END) AS LowCount,
          MAX(CASE 
                WHEN o.Stock <= 0 THEN 3         -- đỏ đậm (hết)
                WHEN o.Stock < @RD THEN 2        -- đỏ nhạt (1..2)
                WHEN o.Stock < @TH THEN 1        -- vàng (3..9)
                ELSE 0                           -- xanh (>=10)
              END) AS Severity
        FROM dbo.ProductOptions o
        JOIN dbo.Products p ON p.ProductID = o.ProductID
        WHERE o.IsActive = 1
        GROUP BY p.ProductID, p.Name
        ORDER BY Severity DESC, MinStock ASC, p.ProductID
      `);
    res.json(rs.recordset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
