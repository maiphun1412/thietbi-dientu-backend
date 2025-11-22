// controllers/cartController.js
'use strict';

const { getPool, sql } = require('../config/db');

/** Convert '/uploads/x.jpg' -> 'http://host/uploads/x.jpg' */
function toAbsoluteUrl(req, p) {
  if (!p) return '';
  const s = String(p);
  if (/^https?:\/\//i.test(s)) return s;
  return `${req.protocol}://${req.get('host')}${s.startsWith('/') ? s : '/' + s}`;
}

/** Lấy userId từ token; nếu thiếu thì lookup theo email trong DB. */
async function resolveUserId(req, res) {
  // 1) từ các biến phổ biến
  const raw =
    req.user?.userId ??
    req.user?.UserId ??
    req.user?.UserID ??
    req.user?.id;
  const id = Number(raw);
  if (Number.isFinite(id) && id > 0) return id;

  // 2) fallback theo email
  const email =
    req.user?.email ??
    req.user?.Email ??
    req.user?.username ??
    req.user?.userName;
  if (!email) {
    res.status(401).json({ message: 'Unauthorized: token has no user id/email' });
    return null;
  }
  const pool = await getPool();
  const rs = await pool.request()
    .input('Email', sql.NVarChar, email)
    .query('SELECT UserID FROM dbo.Users WHERE Email = @Email;');

  if (!rs.recordset.length) {
    res.status(401).json({ message: 'Unauthorized: user not found' });
    return null;
  }
  return Number(rs.recordset[0].UserID);
}

/** Đảm bảo user có Cart, trả về CartID */
async function ensureCartId(pool, userId) {
  const rs = await pool.request()
    .input('UserId', sql.Int, userId)
    .query(`
      DECLARE @id INT;
      SELECT @id = CartID FROM dbo.Carts WHERE UserID = @UserId;
      IF @id IS NULL
      BEGIN
        INSERT INTO dbo.Carts(UserID) VALUES(@UserId);
        SET @id = SCOPE_IDENTITY();
      END
      SELECT @id AS CartID;
    `);
  return rs.recordset[0].CartID;
}

/** GET /api/cart/my */
exports.getMyCart = async (req, res) => {
  try {
    const userId = await resolveUserId(req, res);
    if (userId == null) return;

    const pool = await getPool();
    const rs = await pool.request()
      .input('UserId', sql.Int, userId)
      .query(`
        SELECT
          ci.CartItemID    AS cartItemId,
          ci.Quantity      AS quantity,
          ci.OptionID      AS optionId,
          p.ProductID      AS productId,
          p.Name           AS name,
          ISNULL(o.Size,'')  AS size,
          ISNULL(o.Color,'') AS color,
          CAST(ISNULL(o.Price, p.Price) AS DECIMAL(18,2)) AS unitPrice,
          invRow.Stock AS stock,
          img.Url AS imagePath
        FROM dbo.Carts c
        JOIN dbo.CartItems  ci ON ci.CartID   = c.CartID
        JOIN dbo.Products   p  ON p.ProductID = ci.ProductID
        LEFT JOIN dbo.ProductOptions o ON o.OptionID = ci.OptionID
        OUTER APPLY (
          SELECT TOP 1 inv.Stock
          FROM dbo.Inventory inv
          WHERE inv.ProductID = ci.ProductID
            AND (
              (ci.OptionID IS NULL AND inv.OptionID IS NULL) OR
              (ci.OptionID IS NOT NULL AND inv.OptionID = ci.OptionID)
            )
        ) invRow
        OUTER APPLY (
          SELECT TOP 1 pi.Url
          FROM dbo.ProductImages pi
          WHERE pi.ProductID = p.ProductID
          ORDER BY CASE WHEN ISNULL(pi.IsMain,0)=1 THEN 0 ELSE 1 END, pi.ImageID
        ) img
        WHERE c.UserID = @UserId
        ORDER BY ci.CartItemID DESC;
      `);

    const items = rs.recordset.map(r => {
      const absImg = toAbsoluteUrl(req, r.imagePath);
      return {
        cartItemId: r.cartItemId,
        quantity  : r.quantity,
        optionId  : r.optionId,
        product: {
          id   : r.productId,
          name : r.name,
          image: absImg,       // giữ key cũ
          imageUrl: absImg,    // ✅ alias cho FE đang dùng
          thumb: absImg,       // ✅ alias phổ biến
        },
        variant: { size: r.size, color: r.color },
        unitPrice: Number(r.unitPrice),
        stock    : r.stock ?? 0
      };
    });

    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: 'Lấy giỏ hàng thất bại', error: err.message });
  }
};


/** POST /api/cart/add { productId, optionId?, quantity? } */
exports.addToCart = async (req, res) => {
  try {
    const userId = await resolveUserId(req, res);
    if (userId == null) return;

    const productId = Number(req.body?.productId);
    const optionId  = req.body?.optionId != null ? Number(req.body.optionId) : null;
    const quantity  = Number(req.body?.quantity ?? 1);

    if (!Number.isFinite(productId) || productId <= 0) return res.status(400).json({ message:'productId không hợp lệ' });
    if (!Number.isFinite(quantity)  || quantity <= 0)   return res.status(400).json({ message:'quantity không hợp lệ' });

    const pool   = await getPool();
    const cartId = await ensureCartId(pool, userId);

    // SP có bao nhiêu option?
    const cnt = await pool.request()
      .input('pid', sql.Int, productId)
      .query(`SELECT COUNT(1) AS Cnt FROM dbo.ProductOptions WHERE ProductID=@pid`);
    const hasOptions = (cnt.recordset?.[0]?.Cnt ?? 0) > 0;

    if (hasOptions && !optionId)
      return res.status(400).json({ message: 'Sản phẩm có lựa chọn. Vui lòng chọn Màu/Size' });

    // kiểm tra tồn kho
    if (optionId) {
      // có optionId: check thuộc product + check tồn theo OptionID
      const ok = await pool.request()
        .input('oid', sql.Int, optionId).input('pid', sql.Int, productId)
        .query(`SELECT 1 FROM dbo.ProductOptions WHERE OptionID=@oid AND ProductID=@pid`);
      if (!ok.recordset.length) return res.status(400).json({ message: 'OptionID không thuộc ProductID' });

      const st = await pool.request()
        .input('oid', sql.Int, optionId)
        .query(`SELECT ISNULL(Stock,0) AS Stock FROM dbo.Inventory WHERE OptionID=@oid`);
      const stock = st.recordset[0]?.Stock ?? 0;
      if (stock < quantity) return res.status(409).json({ message:'Hết hàng hoặc không đủ số lượng' });
    } else {
      // không có optionId: dùng dòng Inventory với OptionID IS NULL
      const st = await pool.request()
        .input('pid', sql.Int, productId)
        .query(`
          SELECT ISNULL(Stock,0) AS Stock
          FROM dbo.Inventory
          WHERE ProductID=@pid AND OptionID IS NULL
        `);
      const stock = st.recordset[0]?.Stock ?? 0;
      if (stock < quantity) return res.status(409).json({ message:'Hết hàng hoặc không đủ số lượng' });
    }

    // cộng dồn theo cặp (ProductID, OptionID)
    const row = await pool.request()
      .input('CartID', sql.Int, cartId)
      .input('ProductID', sql.Int, productId)
      .input('OptionID', sql.Int, optionId)
      .query(`
        SELECT CartItemID FROM dbo.CartItems
        WHERE CartID=@CartID AND ProductID=@ProductID
          AND ((OptionID=@OptionID) OR (OptionID IS NULL AND @OptionID IS NULL));
      `);

    if (row.recordset.length) {
      await pool.request()
        .input('CartID', sql.Int, cartId)
        .input('ProductID', sql.Int, productId)
        .input('OptionID', sql.Int, optionId)
        .input('AddQty', sql.Int, quantity)
        .query(`
          UPDATE dbo.CartItems
          SET Quantity = Quantity + @AddQty
          WHERE CartID=@CartID AND ProductID=@ProductID
            AND ((OptionID=@OptionID) OR (OptionID IS NULL AND @OptionID IS NULL));
        `);
    } else {
      await pool.request()
        .input('CartID', sql.Int, cartId)
        .input('ProductID', sql.Int, productId)
        .input('OptionID', sql.Int, optionId)
        .input('Qty', sql.Int, quantity)
        .query(`INSERT INTO dbo.CartItems(CartID, ProductID, OptionID, Quantity) VALUES(@CartID, @ProductID, @OptionID, @Qty)`);
    }

    res.json({ message:'Đã thêm vào giỏ' });
  } catch (err) {
    res.status(500).json({ message:'Thêm giỏ thất bại', error: err.message });
  }
};


/** PATCH /api/cart/quantity  { productId, optionId?, quantity } */
exports.updateQuantity = async (req, res) => {
  try {
    const userId = await resolveUserId(req, res);
    if (userId == null) return;

    const productId = Number(req.body?.productId);
    const optionId  = req.body?.optionId != null ? Number(req.body.optionId) : null;
    const quantity  = Number(req.body?.quantity);

    if (!Number.isFinite(productId) || productId <= 0) return res.status(400).json({ message:'productId không hợp lệ' });
    if (!Number.isFinite(quantity)) return res.status(400).json({ message:'quantity không hợp lệ' });

    const pool   = await getPool();
    const cartId = await ensureCartId(pool, userId);

    if (quantity <= 0) {
      await pool.request()
        .input('CartID', sql.Int, cartId)
        .input('ProductID', sql.Int, productId)
        .input('OptionID', sql.Int, optionId)
        .query(`
          DELETE FROM dbo.CartItems
          WHERE CartID=@CartID AND ProductID=@ProductID
            AND ((OptionID=@OptionID) OR (OptionID IS NULL AND @OptionID IS NULL));
        `);
    } else {
      await pool.request()
        .input('CartID', sql.Int, cartId)
        .input('ProductID', sql.Int, productId)
        .input('OptionID', sql.Int, optionId)
        .input('Qty', sql.Int, quantity)
        .query(`
          UPDATE dbo.CartItems
          SET Quantity=@Qty
          WHERE CartID=@CartID AND ProductID=@ProductID
            AND ((OptionID=@OptionID) OR (OptionID IS NULL AND @OptionID IS NULL));
        `);
    }
    res.json({ message:'OK' });
  } catch (err) {
    res.status(500).json({ message:'Cập nhật thất bại', error: err.message });
  }
};


/** DELETE /api/cart/item/:productId(/:optionId)? */
exports.removeFromCart = async (req, res) => {
  try {
    const userId   = await resolveUserId(req, res);
    if (userId == null) return;

    const productId = Number(req.params.productId);
    // ưu tiên param, nếu không có thì lấy query
    const optionId  = req.params.optionId
      ? Number(req.params.optionId)
      : (req.query.optionId ? Number(req.query.optionId) : null);

    const pool   = await getPool();
    const cartId = await ensureCartId(pool, userId);

    await pool.request()
      .input('CartID', sql.Int, cartId)
      .input('ProductID', sql.Int, productId)
      .input('OptionID', sql.Int, optionId)
      .query(`
        DELETE FROM dbo.CartItems
        WHERE CartID=@CartID AND ProductID=@ProductID
          AND ((OptionID=@OptionID) OR (OptionID IS NULL AND @OptionID IS NULL));
      `);

    res.json({ message: 'Đã xoá' });
  } catch (err) {
    res.status(500).json({ message:'Xoá thất bại', error: err.message });
  }
};


/** DELETE /api/cart/clear */
exports.clearCart = async (req, res) => {
  try {
    const userId = await resolveUserId(req, res);
    if (userId == null) return;

    const pool   = await getPool();
    const cartId = await ensureCartId(pool, userId);

    await pool.request()
      .input('CartID', sql.Int, cartId)
      .query(`DELETE FROM dbo.CartItems WHERE CartID=@CartID;`);

    res.json({ message: 'Đã xoá giỏ hàng' });
  } catch (err) {
    console.error('[cart.clearCart] error:', err.message || err);
    res.status(500).json({ message: 'Xoá giỏ thất bại', error: err.message });
  }
};
