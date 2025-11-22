// controllers/adminProductController.js
'use strict';

const fs   = require('fs');
const path = require('path');
const { getPool, sql } = require('../config/db');

/* ---------- helpers ---------- */
// NEW: tạo slug từ tên (bỏ dấu, khoảng trắng -> '-')
function slugify(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fileToUrl(file) {
  // Multer lưu file vào /public/uploads => trả URL dạng /uploads/xxx.jpg
  return '/uploads/' + path.basename(file.path || file.filename || '');
}

async function selectDetail(pool, id) {
  const rs = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT TOP 1 * FROM Products WHERE ProductID=@id;

      SELECT ImageID, Url, IsMain
      FROM ProductImages WHERE ProductID=@id
      ORDER BY CASE WHEN IsMain=1 THEN 0 ELSE 1 END, ImageID;

      SELECT OptionID, Size, Color, Stock
      FROM ProductOptions WHERE ProductID=@id
      ORDER BY OptionID DESC;
    `);

  if (!rs.recordsets[0].length) return null;

  return {
    product: rs.recordsets[0][0],
    images : rs.recordsets[1],
    options: rs.recordsets[2],
  };
}

/* ---------- LIST: /api/admin/products ---------- */
exports.list = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 20, 1), 100);
    const q = (req.query.q || '').toString().trim();

    const pool = await getPool();
    const where = q
      ? 'WHERE p.IsActive=1 AND (p.Name LIKE @kw OR p.Description LIKE @kw)'
      : 'WHERE p.IsActive=1';
    const kw = `%${q}%`;

    const rs = await pool.request()
      .input('kw', sql.NVarChar, kw)
      .input('offset', sql.Int, (page - 1) * pageSize)
      .input('limit', sql.Int, pageSize)
      .query(`
        SELECT COUNT(*) AS Total
        FROM Products p ${q ? 'WHERE p.IsActive=1 AND (p.Name LIKE @kw OR p.Description LIKE @kw)' : 'WHERE p.IsActive=1'};

        ;WITH img AS (
          SELECT i.ProductID, MIN(CASE WHEN i.IsMain=1 THEN 0 ELSE 1 END) AS ord
          FROM ProductImages i
          GROUP BY i.ProductID
        )
        SELECT p.ProductID, p.Name, p.Price, p.Stock, p.CategoryID, p.IsActive,
               COALESCE(pi.Url, '') AS MainImage,
               ISNULL(opt.cnt,0) AS OptionCount
        FROM Products p
        OUTER APPLY (
          SELECT TOP 1 i.Url
          FROM ProductImages i
          WHERE i.ProductID = p.ProductID
          ORDER BY CASE WHEN i.IsMain=1 THEN 0 ELSE 1 END, i.ImageID
        ) pi
        OUTER APPLY (
          SELECT COUNT(*) AS cnt FROM ProductOptions o WHERE o.ProductID = p.ProductID
        ) opt
        ${where}
        ORDER BY p.ProductID DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
      `);

    return res.json({
      total: rs.recordsets[0][0].Total,
      page,
      pageSize,
      items: rs.recordsets[1],
    });
  } catch (e) {
    console.error('[admin products list] error:', e);
    return res.status(500).json({ message: 'Lỗi tải danh sách', error: e.message });
  }
};

/* ---------- DETAIL: /api/admin/products/:id ---------- */
exports.detail = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pool = await getPool();

    const data = await selectDetail(pool, id);
    if (!data) return res.status(404).json({ message: 'Không tìm thấy' });
    return res.json(data);
  } catch (e) {
    console.error('[admin products detail] error:', e);
    return res.status(500).json({ message: 'Lỗi tải chi tiết', error: e.message });
  }
};

/* ---------- CREATE: POST /api/admin/products ---------- */
exports.create = async (req, res) => {
  try {
    const {
      Name, Description, Price, Stock, CategoryID,
      IsActive = 1, mainIndex,
      // NEW: chấp nhận Slug hoặc slug từ FE
      Slug: SlugBody, slug: slugBody
    } = req.body || {};

    const pool = await getPool();

    // NEW: chuẩn hoá slug (nếu không gửi thì tạo từ Name)
    let slug = (SlugBody ?? slugBody ?? '').toString().trim();
    if (!slug) slug = slugify(Name);

    const ins = await pool.request()
      .input('Name',        sql.NVarChar, (Name || '').toString().trim())
      .input('Slug',        sql.NVarChar, slug) // NEW
      .input('Description', sql.NVarChar, (Description || '').toString())
      .input('Price',       sql.Decimal(18,2), Number(Price) || 0)
      .input('Stock',       sql.Int, Number(Stock) || 0)
      .input('CategoryID',  sql.Int, CategoryID ? Number(CategoryID) : null)
      .input('IsActive',    sql.Bit, (String(IsActive) === '0' ? 0 : 1))
      .query(`
        INSERT INTO Products (Name, Slug, Description, Price, Stock, CategoryID, IsActive, CreatedAt)
        OUTPUT inserted.ProductID
        VALUES (@Name, @Slug, @Description, @Price, @Stock, @CategoryID, @IsActive, SYSDATETIME());
      `);

    const productId = ins.recordset[0].ProductID;

    // images (optional)
    const files = req.files || [];
    if (files.length) {
      const wantMain = (mainIndex != null) ? Number(mainIndex) : 0;
      for (let i = 0; i < files.length; i++) {
        const url = fileToUrl(files[i]);
        await pool.request()
          .input('ProductID', sql.Int, productId)
          .input('Url',       sql.NVarChar, url)
          .input('IsMain',    sql.Bit, i === wantMain ? 1 : 0)
          .query(`
            INSERT INTO ProductImages (ProductID, Url, IsMain)
            VALUES (@ProductID, @Url, @IsMain);
          `);
      }
      // nếu chưa có ảnh main (mainIndex out of range) => đặt ảnh đầu làm main
      await pool.request()
        .input('ProductID', sql.Int, productId)
        .query(`
          IF NOT EXISTS (SELECT 1 FROM ProductImages WHERE ProductID=@ProductID AND IsMain=1)
          BEGIN
            UPDATE TOP(1) ProductImages SET IsMain=1 WHERE ProductID=@ProductID ORDER BY ImageID;
          END
        `);
    }

    const data = await selectDetail(pool, productId);
    return res.status(201).json(data);
  } catch (e) {
    console.error('[admin products create] error:', e);
    return res.status(500).json({ message: 'Lỗi tạo sản phẩm', error: e.message });
  }
};

/* ---------- UPDATE: PUT /api/admin/products/:id ---------- */
exports.update = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      Name, Description, Price, Stock, CategoryID,
      IsActive, mainIndex,
      // NEW: cho phép cập nhật slug
      Slug: SlugBody, slug: slugBody
    } = req.body || {};

    const pool = await getPool();

    // NEW: nếu FE gửi Slug/slug thì dùng; nếu không gửi -> giữ nguyên (null để COALESCE)
    let slug = null;
    if (SlugBody != null || slugBody != null) {
      const raw = (SlugBody ?? slugBody ?? '').toString().trim();
      slug = raw ? raw : null; // rỗng => bỏ qua (COALESCE giữ giá trị cũ)
    }

    await pool.request()
      .input('ProductID',   sql.Int, id)
      .input('Name',        sql.NVarChar, Name != null ? String(Name).trim() : null)
      .input('Slug',        sql.NVarChar, slug) // NEW
      .input('Description', sql.NVarChar, Description != null ? String(Description) : null)
      .input('Price',       sql.Decimal(18,2), Price != null ? Number(Price) : null)
      .input('Stock',       sql.Int, Stock != null ? Number(Stock) : null)
      .input('CategoryID',  sql.Int, CategoryID != null ? Number(CategoryID) : null)
      .input('IsActive',    sql.Bit, IsActive != null ? (String(IsActive) === '0' ? 0 : 1) : null)
      .query(`
        UPDATE Products
        SET Name = COALESCE(@Name, Name),
            Slug = COALESCE(@Slug, Slug),              -- NEW
            Description = COALESCE(@Description, Description),
            Price = COALESCE(@Price, Price),
            Stock = COALESCE(@Stock, Stock),
            CategoryID = COALESCE(@CategoryID, CategoryID),
            IsActive = COALESCE(@IsActive, IsActive),
            UpdatedAt = SYSDATETIME()
        WHERE ProductID=@ProductID;
      `);

    // ảnh mới (nếu có)
    const files = req.files || [];
    if (files.length) {
      const wantMain = (mainIndex != null) ? Number(mainIndex) : -1;
      for (let i = 0; i < files.length; i++) {
        const url = fileToUrl(files[i]);
        await pool.request()
          .input('ProductID', sql.Int, id)
          .input('Url',       sql.NVarChar, url)
          .input('IsMain',    sql.Bit, i === wantMain ? 1 : 0)
          .query(`INSERT INTO ProductImages(ProductID, Url, IsMain) VALUES(@ProductID, @Url, @IsMain);`);
      }
      if (wantMain >= 0) {
        await pool.request()
          .input('pid', sql.Int, id)
          .query(`
            UPDATE ProductImages SET IsMain=0 WHERE ProductID=@pid;
            UPDATE TOP(1) ProductImages SET IsMain=1
            WHERE ProductID=@pid ORDER BY ImageID DESC;
          `);
      }
    }

    const data = await selectDetail(pool, id);
    return res.json(data);
  } catch (e) {
    console.error('[admin products update] error:', e);
    return res.status(500).json({ message: 'Lỗi cập nhật', error: e.message });
  }
};

/* ---------- DELETE (soft): DELETE /api/admin/products/:id ---------- */
exports.remove = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, id)
      .query(`UPDATE Products SET IsActive=0, UpdatedAt=SYSDATETIME() WHERE ProductID=@id;`);
    return res.json({ message: 'Đã vô hiệu hoá sản phẩm' });
  } catch (e) {
    console.error('[admin products delete] error:', e);
    return res.status(500).json({ message: 'Lỗi xoá', error: e.message });
  }
};

/* ---------- IMAGES: set main ---------- */
exports.setMainImage = async (req, res) => {
  try {
    const productId = Number(req.params.id);
    const imageId   = Number(req.params.imageId);
    const pool = await getPool();

    await pool.request().input('pid', sql.Int, productId)
      .query('UPDATE ProductImages SET IsMain=0 WHERE ProductID=@pid;');

    await pool.request().input('iid', sql.Int, imageId)
      .query('UPDATE ProductImages SET IsMain=1 WHERE ImageID=@iid;');

    return res.json({ message: 'Đã đặt ảnh đại diện' });
  } catch (e) {
    console.error('[admin products setMainImage] error:', e);
    return res.status(500).json({ message: 'Lỗi đặt ảnh đại diện', error: e.message });
  }
};

/* ---------- IMAGES: delete ---------- */
exports.deleteImage = async (req, res) => {
  try {
    const imageId = Number(req.params.imageId);
    const pool = await getPool();

    const c = await pool.request()
      .input('iid', sql.Int, imageId)
      .query('SELECT TOP 1 Url FROM ProductImages WHERE ImageID=@iid;');

    if (c.recordset.length) {
      const url = c.recordset[0].Url;               // '/uploads/xxx.jpg'
      const filePath = path.join(__dirname, '..', 'public', url.replace(/^\/+/, ''));
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
    await pool.request().input('iid', sql.Int, imageId)
      .query('DELETE FROM ProductImages WHERE ImageID=@iid;');

    return res.json({ message: 'Đã xoá ảnh' });
  } catch (e) {
    console.error('[admin products deleteImage] error:', e);
    return res.status(500).json({ message: 'Lỗi xoá ảnh', error: e.message });
  }
};

/* ---------- OPTIONS (variants) ---------- */
exports.addOption = async (req, res) => {
  try {
    const productId = Number(req.params.id);
    const { Size, Color, Stock } = req.body || {};
    const pool = await getPool();

    const rs = await pool.request()
      .input('ProductID', sql.Int, productId)
      .input('Size', sql.NVarChar, Size != null ? String(Size) : null)
      .input('Color', sql.NVarChar, Color != null ? String(Color) : null)
      .input('Stock', sql.Int, Stock != null ? Number(Stock) : 0)
      .query(`
        INSERT INTO ProductOptions(ProductID, Size, Color, Stock)
        OUTPUT inserted.OptionID, inserted.Size, inserted.Color, inserted.Stock
        VALUES(@ProductID, @Size, @Color, @Stock);
      `);

    return res.status(201).json(rs.recordset[0]);
  } catch (e) {
    console.error('[admin products addOption] error:', e);
    return res.status(500).json({ message: 'Lỗi thêm biến thể', error: e.message });
  }
};

exports.updateOption = async (req, res) => {
  try {
    const optionId = Number(req.params.optionId);
    const { Size, Color, Stock } = req.body || {};
    const pool = await getPool();

    await pool.request()
      .input('id', sql.Int, optionId)
      .input('Size', sql.NVarChar, Size != null ? String(Size) : null)
      .input('Color', sql.NVarChar, Color != null ? String(Color) : null)
      .input('Stock', sql.Int, Stock != null ? Number(Stock) : null)
      .query(`
        UPDATE ProductOptions
        SET Size = COALESCE(@Size, Size),
            Color = COALESCE(@Color, Color),
            Stock = COALESCE(@Stock, Stock)
        WHERE OptionID=@id;
      `);

    return res.json({ message: 'Đã cập nhật biến thể' });
  } catch (e) {
    console.error('[admin products updateOption] error:', e);
    return res.status(500).json({ message: 'Lỗi cập nhật biến thể', error: e.message });
  }
};

exports.deleteOption = async (req, res) => {
  try {
    const optionId = Number(req.params.optionId);
    const pool = await getPool();
    await pool.request().input('id', sql.Int, optionId)
      .query('DELETE FROM ProductOptions WHERE OptionID=@id;');
    return res.json({ message: 'Đã xoá biến thể' });
  } catch (e) {
    console.error('[admin products deleteOption] error:', e);
    return res.status(500).json({ message: 'Lỗi xoá biến thể', error: e.message });
  }
};
