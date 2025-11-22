// controllers/categoryController.js
const { getPool, sql } = require('../config/db');

function toAbsoluteUrl(req, url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const base = `${req.protocol}://${req.get('host')}`;
  return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
}

/** Lấy danh sách category (kèm ảnh đại diện nếu có) */
exports.getAllCategories = async (req, res) => {
  const query = `
    SELECT
      c.CategoryID AS id,
      c.Name       AS name,
      c.ParentID   AS parentId,
      c.SortOrder  AS sortOrder,
      img.Url      AS imagePath
    FROM dbo.Categories c
    OUTER APPLY (
      SELECT TOP 1 ci.Url
      FROM dbo.CategoryImages ci
      WHERE ci.CategoryID = c.CategoryID
      ORDER BY CASE WHEN ISNULL(ci.IsMain, 0) = 1 THEN 0 ELSE 1 END, ci.ImageID
    ) img
    ORDER BY c.SortOrder ASC, c.CategoryID ASC;
  `;
  try {
    const pool = await getPool();
    const rs = await pool.request().query(query);
    const rows = (rs.recordset || []).map(r => ({
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      sortOrder: r.sortOrder,
      image: toAbsoluteUrl(req, r.imagePath),
    }));
    res.json(rows);
  } catch (err) {
    console.error('[category.getAllCategories]', err);
    res.status(500).json({ message: 'Failed to load categories' });
  }
};

/** Lấy ảnh của 1 category */
exports.getCategoryImages = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid category id' });

  const q = `
    SELECT ImageID AS id, Url AS url, IsMain AS isMain
    FROM dbo.CategoryImages
    WHERE CategoryID = @id
    ORDER BY IsMain DESC, ImageID ASC;
  `;
  try {
    const pool = await getPool();
    const rs = await pool.request().input('id', sql.Int, id).query(q);
    res.json((rs.recordset || []).map(r => ({
      id: r.id,
      url: toAbsoluteUrl(req, r.url),
      isMain: Boolean(r.isMain),
    })));
  } catch (err) {
    console.error('[category.getCategoryImages]', err);
    res.status(500).json({ message: 'Failed to load category images' });
  }
};

/** Lấy ảnh chính (main) của 1 category */
exports.getMainCategoryImage = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid category id' });

  const q = `
    SELECT TOP 1 Url
    FROM dbo.CategoryImages
    WHERE CategoryID = @id
    ORDER BY CASE WHEN ISNULL(IsMain,0)=1 THEN 0 ELSE 1 END, ImageID ASC;
  `;
  try {
    const pool = await getPool();
    const rs = await pool.request().input('id', sql.Int, id).query(q);
    const url = rs.recordset[0]?.Url || null;
    res.json({ imageUrl: url ? toAbsoluteUrl(req, url) : null });
  } catch (err) {
    console.error('[category.getMainCategoryImage]', err);
    res.status(500).json({ message: 'Failed to load main image' });
  }
};

/** Lấy 1 category theo ID (== handler thiếu khiến router báo lỗi) */
exports.getCategoryById = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid id' });

  const q = `
    WITH Img AS (
      SELECT TOP 1 Url
      FROM dbo.CategoryImages
      WHERE CategoryID = @id
      ORDER BY CASE WHEN ISNULL(IsMain,0)=1 THEN 0 ELSE 1 END, ImageID ASC
    )
    SELECT
      c.CategoryID AS id,
      c.Name       AS name,
      c.ParentID   AS parentId,
      c.SortOrder  AS sortOrder,
      i.Url        AS imagePath
    FROM dbo.Categories c
    OUTER APPLY Img i
    WHERE c.CategoryID = @id;
  `;
  try {
    const pool = await getPool();
    const rs = await pool.request().input('id', sql.Int, id).query(q);
    if (!rs.recordset.length) {
      return res.status(404).json({ message: 'Không tìm thấy danh mục' });
    }
    const r = rs.recordset[0];
    res.json({
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      sortOrder: r.sortOrder,
      image: toAbsoluteUrl(req, r.imagePath),
    });
  } catch (err) {
    console.error('[category.getCategoryById]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/** Tạo category */
exports.createCategory = async (req, res) => {
  try {
    const { name, parentId, sortOrder } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const pool = await getPool();
    const r = await pool.request()
      .input('Name', sql.NVarChar(255), name.trim())
      .input('ParentID', sql.Int, parentId ?? null)
      .input('SortOrder', sql.Int, sortOrder ?? 0)
      .query(`
        INSERT INTO dbo.Categories (Name, ParentID, SortOrder, CreatedAt)
        OUTPUT INSERTED.CategoryID AS id
        VALUES (@Name, @ParentID, @SortOrder, GETDATE());
      `);

    res.status(201).json({ id: r.recordset[0].id, message: 'Tạo danh mục thành công' });
  } catch (e) {
    console.error('[category.createCategory]', e);
    res.status(500).json({ message: 'Server error' });
  }
};

/** Cập nhật category */
exports.updateCategory = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid id' });

    const { name, parentId, sortOrder } = req.body || {};
    const pool = await getPool();

    await pool.request()
      .input('id', sql.Int, id)
      .input('Name', sql.NVarChar(255), name ?? null)
      .input('ParentID', sql.Int, parentId ?? null)
      .input('SortOrder', sql.Int, sortOrder ?? null)
      .query(`
        UPDATE dbo.Categories
        SET 
          Name = COALESCE(@Name, Name),
          ParentID = COALESCE(@ParentID, ParentID),
          SortOrder = COALESCE(@SortOrder, SortOrder),
          UpdatedAt = GETDATE()
        WHERE CategoryID = @id;
      `);

    res.json({ message: 'Cập nhật danh mục thành công' });
  } catch (e) {
    console.error('[category.updateCategory]', e);
    res.status(500).json({ message: 'Server error' });
  }
};

/** Xoá category (xoá kèm ảnh) */
exports.deleteCategory = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid id' });

    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, id)
      .query(`
        DELETE FROM dbo.CategoryImages WHERE CategoryID = @id;
        DELETE FROM dbo.Categories     WHERE CategoryID = @id;
      `);

    res.json({ message: 'Xoá danh mục thành công' });
  } catch (e) {
    console.error('[category.deleteCategory]', e);
    res.status(500).json({ message: 'Server error' });
  }
};
