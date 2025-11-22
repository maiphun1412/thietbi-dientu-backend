// controllers/productController.js
const { getPool, sql } = require('../config/db');
const ProductModel = require('../models/productModel'); // giữ nguyên nếu nơi khác dùng
const express = require('express'); // giữ nguyên

/* -------------------------------------------------------
 * Helpers
 * -----------------------------------------------------*/
function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function toAbsoluteUrl(req, url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const base = `${req.protocol}://${req.get('host')}`; // http(s)://host:port
  return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
}

/* -------------------------------------------------------
 * GET /api/products?categoryId=&page=1&limit=20&q=
 * Trả về: { data: [...], pagination: { page, limit, total } }
 * - Có ảnh chính (image) lấy từ ProductImages (ưu tiên IsMain)
 * - Phân trang OFFSET/FETCH
 * -----------------------------------------------------*/
exports.getAllProducts = async (req, res) => {
  const page   = Math.max(toInt(req.query.page, 1), 1);
  const limit  = Math.min(Math.max(toInt(req.query.limit, 20), 1), 100);
  const offset = (page - 1) * limit;

  // đủ biến thể tham số category
  const catIdRaw = req.query.categoryId ?? req.query.CategoryID ?? req.query.category;
  const catId    = catIdRaw != null && catIdRaw !== '' ? toInt(catIdRaw, null) : null;

  const q     = (req.query.q || '').trim();
  const likeQ = q ? `%${q}%` : '';

  const whereClause = `
    WHERE
      (@catId IS NULL OR p.CategoryID = @catId)
      AND (@like = '' OR p.Name LIKE @like OR p.Description LIKE @like)
  `;

  const sqlText = `
    /* data page */
    WITH Img AS (
      SELECT 
        i.ProductID, 
        i.Url,
        ROW_NUMBER() OVER (
          PARTITION BY i.ProductID
          ORDER BY CASE WHEN ISNULL(i.IsMain,0)=1 THEN 0 ELSE 1 END, i.ImageID
        ) AS rn
      FROM dbo.ProductImages i
    )
    SELECT
      p.ProductID   AS id,
      p.Name        AS name,
      p.Price       AS price,
      p.Slug        AS slug,
      p.Description AS description,
      p.CategoryID  AS categoryId,
      img.Url       AS imagePath
    FROM dbo.Products p
    LEFT JOIN Img img ON img.ProductID = p.ProductID AND img.rn = 1
    ${whereClause}
    ORDER BY p.ProductID DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;

    /* total */
    SELECT COUNT(1) AS total
    FROM dbo.Products p
    ${whereClause};
  `;

  try {
    const pool = await getPool();
    const rq = pool.request()
      .input('offset', sql.Int, offset)
      .input('limit',  sql.Int, limit)
      .input('catId',  sql.Int, catId)       // có thể NULL
      .input('like',   sql.NVarChar, likeQ); // '' nếu không tìm kiếm

    const rs = await rq.query(sqlText);
    const rows  = rs.recordsets?.[0] ?? [];
    const total = rs.recordsets?.[1]?.[0]?.total ?? 0;

    const data = rows.map(r => {
      const abs = toAbsoluteUrl(req, r.imagePath);
      return {
        id: r.id,
        name: r.name,
        price: r.price,
        slug: r.slug,
        description: r.description,
        categoryId: r.categoryId,
        image: abs,   // FE đọc 'image'
        thumb: abs,   // FE đọc 'thumb'
      };
    });

    res.json({ data, pagination: { page, limit, total } });
  } catch (err) {
    console.error('getAllProducts ERROR:', err);
    res.status(500).json({ message: 'Failed to load products', error: err.message });
  }
};

/* -------------------------------------------------------
 * GET /api/products/:id
 * Trả chi tiết + mảng images
 * -----------------------------------------------------*/
exports.getProductDetails = async (req, res) => {
  const productId = parseInt(req.params.id, 10);
  try {
    const pool = await getPool();

    const rs = await pool.request()
      .input('productId', sql.Int, productId)
      .query(`
        WITH Img AS (
          SELECT 
            i.ProductID, 
            i.Url,
            ROW_NUMBER() OVER (
              PARTITION BY i.ProductID
              ORDER BY CASE WHEN ISNULL(i.IsMain,0)=1 THEN 0 ELSE 1 END, i.ImageID
            ) AS rn
          FROM dbo.ProductImages i
        )
        SELECT 
          p.ProductID       AS id,
          p.Name            AS name,
          p.Description     AS description,
          p.Price           AS price,
          ISNULL(p.Sold,0)  AS sold,        -- 👈 THÊM CỘT SOLD
          img.Url           AS imagePath
        FROM dbo.Products p
        LEFT JOIN Img img ON img.ProductID = p.ProductID AND img.rn = 1
        WHERE p.ProductID = @productId
      `);

    if (!rs.recordset.length) {
      return res.status(404).json({ message: 'Không tìm thấy sản phẩm' });
    }

    const product = rs.recordset[0];
    const abs = toAbsoluteUrl(req, product.imagePath);
    const payload = {
      id: product.id,
      name: product.name,
      description: product.description,
      price: product.price,
      imageUrl: abs,                   // tương thích cũ
      image: abs,                      // mới
      thumb: abs,                      // mới
      sold: Number(product.sold ?? 0), // 👈 GỬI RA FE ĐỂ HIỆN "ĐÃ BÁN"
    };

    const opt = await pool.request()
      .input('productId', sql.Int, productId)
      .query(`SELECT Size, Color, Stock FROM dbo.ProductOptions WHERE ProductID = @productId`);

    res.json({ product: payload, options: opt.recordset || [] });
  } catch (e) {
    console.error('getProductDetails ERROR:', e);
    res.status(500).json({ message: 'Lỗi máy chủ', error: e.message });
  }
};

// GET /api/products/:id/options
exports.getProductOptions = async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('productId', sql.Int, parseInt(req.params.id, 10))
      .query(`
        SELECT 
          OptionID,
          ProductID,
          Size, 
          Color, 
          ISNULL(Stock,0) AS Stock
        FROM dbo.ProductOptions
        WHERE ProductID = @productId
        ORDER BY ISNULL(Stock,0) ASC, OptionID ASC
      `);
    res.json(r.recordset || []);
  } catch (e) {
    console.error('getProductOptions ERROR:', e);
    res.status(500).json({ message: 'Lỗi máy chủ', error: e.message });
  }
};


// GET /api/products/:id/images
exports.getProductImages = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: 'Invalid product id' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT 
          Url    AS url,
          IsMain AS isMain
        FROM dbo.ProductImages
        WHERE ProductID = @id
        ORDER BY IsMain DESC, ImageID ASC;
      `);

    const rows = (result.recordset || []).map(r => ({
      url: toAbsoluteUrl(req, r.url),
      isMain: r.isMain
    }));

    return res.json(rows);
  } catch (err) {
    console.error('getProductImages ERROR:', err);
    return res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });
  }
};

/* -------------------------------------------------------
 * POST /api/products
 * Body: { Name, CategoryID?, SupplierID?, Description?, Price, Slug? }
 * Trả { id }
 * -----------------------------------------------------*/
exports.addProduct = async (req, res) => {
  const { Name, CategoryID, SupplierID, Description, Price, Slug } = req.body || {};
  if (!Name || Price == null) {
    return res.status(400).json({ message: 'name & price are required' });
  }
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('Name',        sql.NVarChar(255), Name)
      .input('CategoryID',  sql.Int, CategoryID ?? null)
      .input('SupplierID',  sql.Int, SupplierID ?? null)
      .input('Description', sql.NVarChar(sql.MAX), Description ?? null)
      .input('Price',       sql.Decimal(18, 2), Price)
      .input('Slug',        sql.NVarChar(255), Slug ?? null)
      .query(`
        INSERT INTO Products (Name, CategoryID, SupplierID, Description, Price, Slug, CreatedAt)
        OUTPUT INSERTED.ProductID AS id
        VALUES (@Name, @CategoryID, @SupplierID, @Description, @Price, @Slug, GETDATE());
      `);
    res.status(201).json({ message: 'Thêm thành công', id: r.recordset[0].id });
  } catch (err) {
    console.error('addProduct ERROR:', err);
    res.status(500).json({ message: 'Thất bại', error: err.message });
  }
};

/* -------------------------------------------------------
 * PUT /api/products/:id
 * Body: các field cần cập nhật
 * -----------------------------------------------------*/
exports.updateProduct = async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ message: 'Invalid id' });

  const { Name, CategoryID, SupplierID, Description, Price, Slug } = req.body || {};

  try {
    const pool = await getPool();
    await pool.request()
      .input('id',          sql.Int, id)
      .input('Name',        sql.NVarChar(255), Name ?? null)
      .input('CategoryID',  sql.Int, CategoryID ?? null)
      .input('SupplierID',  sql.Int, SupplierID ?? null)
      .input('Description', sql.NVarChar(sql.MAX), Description ?? null)
      .input('Price',       sql.Decimal(18, 2), Price ?? null)
      .input('Slug',        sql.NVarChar(255), Slug ?? null)
      .query(`
        UPDATE Products SET
          Name        = COALESCE(@Name, Name),
          CategoryID  = COALESCE(@CategoryID, CategoryID),
          SupplierID  = COALESCE(@SupplierID, SupplierID),
          Description = COALESCE(@Description, Description),
          Price       = COALESCE(@Price, Price),
          Slug        = COALESCE(@Slug, Slug)
        WHERE ProductID = @id;
      `);

    res.json({ message: 'Cập nhật thành công' });
  } catch (err) {
    console.error('updateProduct ERROR:', err);
    res.status(500).json({ message: 'Cập nhật không thành công', error: err.message });
  }
};

/* -------------------------------------------------------
 * DELETE /api/products/:id
 * -----------------------------------------------------*/
exports.deleteProduct = async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ message: 'Invalid id' });

  const pool = await getPool();
  const trx = new sql.Transaction(pool);
  try {
    await trx.begin();
    const rq = new sql.Request(trx);
    rq.input('pid', sql.Int, id);

    await rq.query(`
      DELETE FROM WarrantyCards
      WHERE OrderItemID IN (SELECT OrderItemID FROM OrderItems WHERE ProductID = @pid);

      DELETE FROM CartItems            WHERE ProductID = @pid;
      DELETE FROM Inventory            WHERE ProductID = @pid;
      DELETE FROM ProductImages        WHERE ProductID = @pid;
      DELETE FROM ProductPromotions    WHERE ProductID = @pid;
      DELETE FROM PurchaseReceiptItems WHERE ProductID = @pid;
      DELETE FROM Reviews              WHERE ProductID = @pid;
      DELETE FROM StockIssueItems      WHERE ProductID = @pid;
      DELETE FROM OrderItems           WHERE ProductID = @pid;

      DELETE FROM Products WHERE ProductID = @pid;
    `);

    await trx.commit();
    res.json({ message: 'Đã xoá thành công' });
  } catch (err) {
    try { if (trx._aborted !== true) await trx.rollback(); } catch (_) {}
    console.error('deleteProduct ERROR:', err);
    res.status(500).json({ message: 'Xoá thất bại', error: err.message });
  }
};


/* -------------------------------------------------------
 * GET /api/products  — đang dùng bởi FE HomeScreen
 * Hỗ trợ: q, categoryId/CategoryID/category, limit, offset
 * Trả: { items, total }
 * -----------------------------------------------------*/
exports.listProducts = async (req, res) => {
  try {
    const q      = (req.query.q || '').trim();
    const like   = q ? `%${q}%` : '';
    const limit  = Math.min(Math.max(toInt(req.query.limit, 20), 1), 100);
    const offset = Math.max(toInt(req.query.offset, 0), 0);

    const catIdRaw = req.query.categoryId ?? req.query.CategoryID ?? req.query.category;
    const catId    = catIdRaw != null && catIdRaw !== '' ? toInt(catIdRaw, null) : null;

    const pool = await getPool();

    const whereClause = `
      WHERE
        (@catId IS NULL OR p.CategoryID = @catId)
        AND (@like = '' OR p.Name LIKE @like OR p.Description LIKE @like OR CONVERT(varchar(20), p.ProductID) LIKE @like)
    `;

    const rs = await pool.request()
      .input('like',   sql.NVarChar, like)
      .input('limit',  sql.Int, limit)
      .input('offset', sql.Int, offset)
      .input('catId',  sql.Int, catId)
      .query(`
        /* page data */
        WITH Img AS (
          SELECT 
            i.ProductID, 
            i.Url,
            ROW_NUMBER() OVER (
              PARTITION BY i.ProductID
              ORDER BY CASE WHEN ISNULL(i.IsMain,0)=1 THEN 0 ELSE 1 END, i.ImageID
            ) AS rn
          FROM dbo.ProductImages i
        )
        SELECT 
          p.ProductID AS id,
          p.Name      AS name,
          CAST(ISNULL(p.Stock,0) AS int)    AS stock,
          CAST(ISNULL(p.IsActive,1) AS bit) AS isActive,
          CAST(ISNULL(p.Price,0) AS float)  AS price,
          CAST(ISNULL(p.Sold,0) AS int)     AS sold,   -- 👈 thêm sold
          p.CategoryID AS categoryId,
          img.Url AS imagePath
        FROM dbo.Products p
        LEFT JOIN Img img ON img.ProductID = p.ProductID AND img.rn = 1
        ${whereClause}
        ORDER BY p.ProductID DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;

        /* total */
        SELECT COUNT(1) AS total
        FROM dbo.Products p
        ${whereClause};
      `);

    const rows  = rs.recordsets?.[0] ?? [];
    const total = rs.recordsets?.[1]?.[0]?.total ?? 0;

    const items = rows.map(r => {
      const abs = toAbsoluteUrl(req, r.imagePath);
      return {
        id: r.id,
        name: r.name,
        stock: r.stock,
        isActive: Boolean(r.isActive),
        price: r.price,
        sold: r.sold || 0,          // gửi ra FE
        categoryId: r.categoryId,
        image: abs,
        thumb: abs,
      };
    });

    return res.json({ items, total });
  } catch (err) {
    console.error('listProducts ERROR:', err);
    return res.status(500).json({ message: 'Failed to load products', error: err.message });
  }
};
