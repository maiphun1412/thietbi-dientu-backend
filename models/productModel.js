// models/productModel.js
// ✅ dùng chung driver/types từ db.js (msnodesqlv8 – Windows Auth)
const { getPool, sql } = require('../config/db');

/**
 * Tìm / lọc / phân trang sản phẩm (SQL Server)
 */
async function listProducts({ q = '', categoryId, limit = 50, offset = 0, page } = {}) {
  const pool = await getPool();

  const take = Math.max(0, Math.min(Number(limit) || 50, 200));
  const skip = (offset === undefined || offset === null || offset === '')
    ? (Math.max(1, Number(page) || 1) - 1) * take
    : Math.max(0, Number(offset) || 0);

  // Kiểm tra có FULLTEXT INDEX không
  const ft = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM sys.fulltext_indexes
    WHERE object_id = OBJECT_ID('dbo.Products')
  `);
  const hasFT = (ft.recordset[0]?.cnt || 0) > 0;

  const req = pool.request();
  // ✅ CHỈ SELECT các cột có thật trong bảng của bạn
  let sqlText = `
    SELECT
      p.ProductID   AS id,
      p.Name        AS name,
      p.Description AS description,
      p.Price       AS price,
      p.CategoryID  AS categoryId,
      img.Url       AS thumb
    FROM dbo.Products p
    OUTER APPLY (
      SELECT TOP 1 Url
      FROM dbo.ProductImages i
      WHERE i.ProductID = p.ProductID
      ORDER BY i.IsMain DESC, i.ImageID
    ) img
  `;

  const where = [];
  if (q && q.trim()) {
    if (hasFT) { where.push(`CONTAINS((p.Name, p.Description), @contains)`); req.input('contains', sql.NVarChar(4000), `"${q.trim()}*"`); }
    else {       where.push(`(p.Name LIKE @kw OR p.Description LIKE @kw)`);   req.input('kw',       sql.NVarChar(4000), `%${q.trim()}%`); }
  }
  if (categoryId !== undefined && categoryId !== null && `${categoryId}` !== '') {
    where.push(`p.CategoryID = @categoryId`);
    req.input('categoryId', sql.Int, Number(categoryId));
  }
  if (where.length) sqlText += ' WHERE ' + where.join(' AND ');

  sqlText += `
    ORDER BY p.ProductID DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
  `;
  req.input('offset', sql.Int, skip);
  req.input('limit',  sql.Int, take);

  const rs = await req.query(sqlText);
  return rs.recordset;
}

module.exports = { listProducts };