// models/cartModel.js
const { sql, poolPromise } = require('../config/db');

const CartModel = {
  // Lấy giỏ hàng của user (kèm thông tin sản phẩm)
  async getItemsByUser(userId) {
    const pool = await poolPromise;
    const rs = await pool.request()
      .input('userId', sql.VarChar, userId)
      .query(`
        SELECT 
          ci.id,
          ci.user_id    AS userId,
          ci.product_id AS productId,
          ci.quantity,
          p.name,
          p.imageUrl,
          p.price
        FROM CartItems ci
        JOIN Products p ON p.id = ci.product_id
        WHERE ci.user_id = @userId
        ORDER BY ci.id DESC;
      `);
    return rs.recordset;
  },

  // Thêm (nếu đã có thì cộng dồn)
  async addItem(userId, productId, quantity = 1) {
    const pool = await poolPromise;
    const rs = await pool.request()
      .input('userId', sql.VarChar, userId)
      .input('productId', sql.VarChar, productId)
      .input('quantity', sql.Int, quantity)
      .query(`
        MERGE CartItems AS T
        USING (SELECT @userId AS user_id, @productId AS product_id) AS S
        ON (T.user_id = S.user_id AND T.product_id = S.product_id)
        WHEN MATCHED THEN
          UPDATE SET quantity = T.quantity + @quantity
        WHEN NOT MATCHED THEN
          INSERT (user_id, product_id, quantity)
          VALUES (@userId, @productId, @quantity)
        OUTPUT inserted.*;
      `);
    return rs.recordset[0];
  },

  // Cập nhật số lượng (<=0 thì xoá)
  async updateItem(userId, productId, quantity) {
    const pool = await poolPromise;

    if (quantity <= 0) {
      await pool.request()
        .input('userId', sql.VarChar, userId)
        .input('productId', sql.VarChar, productId)
        .query(`DELETE FROM CartItems WHERE user_id = @userId AND product_id = @productId;`);
      return null;
    }

    const rs = await pool.request()
      .input('userId', sql.VarChar, userId)
      .input('productId', sql.VarChar, productId)
      .input('quantity', sql.Int, quantity)
      .query(`
        UPDATE CartItems
        SET quantity = @quantity
        WHERE user_id = @userId AND product_id = @productId;

        SELECT * FROM CartItems
        WHERE user_id = @userId AND product_id = @productId;
      `);
    return rs.recordset[0];
  },

  // Xoá 1 item
  async removeItem(userId, productId) {
    const pool = await poolPromise;
    await pool.request()
      .input('userId', sql.VarChar, userId)
      .input('productId', sql.VarChar, productId)
      .query(`DELETE FROM CartItems WHERE user_id = @userId AND product_id = @productId;`);
    return true;
  },

  // Xoá sạch giỏ
  async clear(userId) {
    const pool = await poolPromise;
    await pool.request()
      .input('userId', sql.VarChar, userId)
      .query(`DELETE FROM CartItems WHERE user_id = @userId;`);
    return true;
  },

  // Kiểm tra sản phẩm có tồn tại không
  async productExists(productId) {
    const pool = await poolPromise;
    const rs = await pool.request()
      .input('productId', sql.VarChar, productId)
      .query(`SELECT 1 AS ok FROM Products WHERE id = @productId;`);
    return rs.recordset.length > 0;
  }
};

module.exports = CartModel;
