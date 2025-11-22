// controllers/orderItemController.js
const { getPool, sql } = require('../config/db');

const ADJUST_STOCK = true; // bật nếu muốn cộng/trừ tồn kho khi thêm/sửa/xoá item

// helper: tính lại tổng tiền của 1 order
async function recomputeOrderTotal(rq, orderId) {
  const sumRs = await rq
    .input('OrderID_sum', sql.Int, orderId)
    .query(`
      SELECT SUM(CAST(oi.Quantity AS DECIMAL(18,2)) * oi.UnitPrice) AS Total
      FROM OrderItems oi
      WHERE oi.OrderID = @OrderID_sum
    `);
  const newTotal = Number(sumRs.recordset[0]?.Total || 0);
  await rq
    .input('OrderID_upd', sql.Int, orderId)
    .input('Total_upd', sql.Decimal(18,2), newTotal)
    .query(`
      UPDATE Orders SET Total = @Total_upd, UpdatedAt = GETDATE()
      WHERE OrderID = @OrderID_upd
    `);
  return newTotal;
}

/* ============ READ ============ */

// GET /api/order-items?orderId=?
exports.getAllOrderItems = async (req, res) => {
  try {
    const pool = await getPool();
    const rq = pool.request();

    let where = '';
    if (req.query.orderId) {
      rq.input('OrderID', sql.Int, parseInt(req.query.orderId, 10));
      where = 'WHERE oi.OrderID = @OrderID';
    }

    const rs = await rq.query(`
      SELECT oi.OrderItemID, oi.OrderID, oi.ProductID,
             oi.Quantity, oi.UnitPrice,
             p.Name AS ProductName
      FROM OrderItems oi
      JOIN Products p ON p.ProductID = oi.ProductID
      ${where}
      ORDER BY oi.OrderItemID DESC
    `);
    res.json(rs.recordset);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi khi lấy chi tiết đơn hàng', error: err.message });
  }
};

// GET /api/order-items/:id
exports.getOrderItemById = async (req, res) => {
  try {
    const pool = await getPool();
    const rs = await pool.request()
      .input('OrderItemID', sql.Int, parseInt(req.params.id, 10))
      .query(`
        SELECT oi.OrderItemID, oi.OrderID, oi.ProductID,
               oi.Quantity, oi.UnitPrice,
               p.Name AS ProductName
        FROM OrderItems oi
        JOIN Products p ON p.ProductID = oi.ProductID
        WHERE oi.OrderItemID = @OrderItemID
      `);
    if (!rs.recordset.length) return res.status(404).json({ message: 'Không tìm thấy chi tiết đơn hàng' });
    res.json(rs.recordset[0]);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi khi tìm chi tiết đơn hàng', error: err.message });
  }
};

/* ============ CREATE ============ */

// POST /api/order-items
// body: { OrderID, ProductID, Quantity, UnitPrice? }
exports.addOrderItem = async (req, res) => {
  const { OrderID, ProductID } = req.body;
  const Quantity = parseInt(req.body.Quantity, 10);

  if (!OrderID || !ProductID || !Quantity || Quantity <= 0) {
    return res.status(400).json({ message: 'Thiếu hoặc sai OrderID/ProductID/Quantity' });
  }

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();
    const rq = new sql.Request(tx);

    // validate order
    const orderRs = await rq.input('OrderID', sql.Int, OrderID)
      .query(`SELECT OrderID FROM Orders WHERE OrderID = @OrderID`);
    if (!orderRs.recordset.length) {
      await tx.rollback(); return res.status(400).json({ message: 'Order không tồn tại' });
    }

    // lấy sản phẩm + giá + tồn
    const prodRs = await rq.input('ProductID', sql.Int, ProductID)
      .query(`SELECT ProductID, Price, Stock FROM Products WHERE ProductID = @ProductID`);
    const prod = prodRs.recordset[0];
    if (!prod) {
      await tx.rollback(); return res.status(400).json({ message: 'Sản phẩm không tồn tại' });
    }
    if (ADJUST_STOCK && prod.Stock < Quantity) {
      await tx.rollback(); return res.status(409).json({ message: 'Không đủ tồn kho' });
    }

    // chốt giá (ưu tiên lấy từ DB để tránh client chỉnh tay)
    const UnitPrice = req.body.UnitPrice != null ? Number(req.body.UnitPrice) : Number(prod.Price);

    // insert
    const ins = await rq
      .input('OrderID_i', sql.Int, OrderID)
      .input('ProductID_i', sql.Int, ProductID)
      .input('Quantity_i', sql.Int, Quantity)
      .input('UnitPrice_i', sql.Decimal(18,2), UnitPrice)
      .query(`
        INSERT INTO OrderItems (OrderID, ProductID, Quantity, UnitPrice)
        OUTPUT INSERTED.OrderItemID
        VALUES (@OrderID_i, @ProductID_i, @Quantity_i, @UnitPrice_i)
      `);
    const newId = ins.recordset[0].OrderItemID;

    // trừ tồn
    if (ADJUST_STOCK) {
      await rq
        .input('ProductID_u', sql.Int, ProductID)
        .input('Quantity_u', sql.Int, Quantity)
        .query(`UPDATE Products SET Stock = Stock - @Quantity_u WHERE ProductID = @ProductID_u`);
    }

    // tính lại tổng
    const newTotal = await recomputeOrderTotal(rq, OrderID);

    await tx.commit();
    res.status(201).json({
      message: 'Đã thêm chi tiết đơn hàng',
      item: { OrderItemID: newId, OrderID, ProductID, Quantity, UnitPrice },
      orderTotal: newTotal,
    });
  } catch (err) {
    try { await tx.rollback(); } catch {}
    res.status(500).json({ message: 'Lỗi thêm chi tiết đơn hàng', error: err.message });
  }
};

/* ============ UPDATE ============ */

// PUT /api/order-items/:id
// body: { Quantity, UnitPrice? }
exports.updateOrderItem = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const Quantity = req.body.Quantity != null ? parseInt(req.body.Quantity, 10) : null;
  const UnitPrice = req.body.UnitPrice != null ? Number(req.body.UnitPrice) : null;

  if (!id) return res.status(400).json({ message: 'Thiếu OrderItemID' });
  if (Quantity != null && Quantity <= 0) return res.status(400).json({ message: 'Quantity phải > 0' });

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();
    const rq = new sql.Request(tx);

    // lấy item cũ
    const oldRs = await rq.input('OrderItemID', sql.Int, id).query(`
      SELECT OrderItemID, OrderID, ProductID, Quantity, UnitPrice FROM OrderItems WHERE OrderItemID = @OrderItemID
    `);
    const old = oldRs.recordset[0];
    if (!old) { await tx.rollback(); return res.status(404).json({ message: 'Không tìm thấy item' }); }

    // tính delta tồn kho nếu cần
    if (ADJUST_STOCK && Quantity != null) {
      const delta = Quantity - old.Quantity; // >0: cần thêm hàng; <0: trả hàng
      if (delta !== 0) {
        const prodRs = await rq.input('ProductID_chk', sql.Int, old.ProductID)
          .query(`SELECT Stock FROM Products WHERE ProductID = @ProductID_chk`);
        const stock = prodRs.recordset[0]?.Stock ?? 0;
        if (delta > 0 && stock < delta) {
          await tx.rollback(); return res.status(409).json({ message: 'Không đủ tồn kho để tăng số lượng' });
        }
        // cập nhật tồn kho
        if (delta !== 0) {
          await rq
            .input('ProductID_adj', sql.Int, old.ProductID)
            .input('Delta', sql.Int, delta)
            .query(`UPDATE Products SET Stock = Stock - @Delta WHERE ProductID = @ProductID_adj`);
        }
      }
    }

    // cập nhật dòng
    const q = [];
    const reqUpd = rq.input('OrderItemID_upd', sql.Int, id);
    if (Quantity != null) { q.push('Quantity = @Quantity_upd'); reqUpd.input('Quantity_upd', sql.Int, Quantity); }
    if (UnitPrice != null){ q.push('UnitPrice = @UnitPrice_upd'); reqUpd.input('UnitPrice_upd', sql.Decimal(18,2), UnitPrice); }

    if (!q.length) { await tx.rollback(); return res.status(400).json({ message: 'Không có gì để cập nhật' }); }

    await reqUpd.query(`UPDATE OrderItems SET ${q.join(', ') } WHERE OrderItemID = @OrderItemID_upd`);

    // tính lại tổng
    const newTotal = await recomputeOrderTotal(rq, old.OrderID);

    await tx.commit();
    res.json({ message: 'Cập nhật chi tiết đơn hàng thành công', orderTotal: newTotal });
  } catch (err) {
    try { await tx.rollback(); } catch {}
    res.status(500).json({ message: 'Lỗi cập nhật chi tiết đơn hàng', error: err.message });
  }
};

/* ============ DELETE ============ */

// DELETE /api/order-items/:id
exports.deleteOrderItem = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'Thiếu OrderItemID' });

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();
    const rq = new sql.Request(tx);

    // lấy item để biết OrderID + ProductID + Quantity
    const rs = await rq.input('OrderItemID', sql.Int, id).query(`
      SELECT OrderID, ProductID, Quantity FROM OrderItems WHERE OrderItemID = @OrderItemID
    `);
    const row = rs.recordset[0];
    if (!row) { await tx.rollback(); return res.status(404).json({ message: 'Không tìm thấy item' }); }

    // xoá item
    await rq.input('OrderItemID_del', sql.Int, id).query(`DELETE FROM OrderItems WHERE OrderItemID = @OrderItemID_del`);

    // trả lại tồn kho
    if (ADJUST_STOCK) {
      await rq
        .input('ProductID_ret', sql.Int, row.ProductID)
        .input('Quantity_ret', sql.Int, row.Quantity)
        .query(`UPDATE Products SET Stock = Stock + @Quantity_ret WHERE ProductID = @ProductID_ret`);
    }

    // tính lại tổng
    const newTotal = await recomputeOrderTotal(rq, row.OrderID);

    await tx.commit();
    res.json({ message: 'Chi tiết đơn hàng đã được xóa', orderTotal: newTotal });
  } catch (err) {
    try { await tx.rollback(); } catch {}
    res.status(500).json({ message: 'Lỗi xóa chi tiết đơn hàng', error: err.message });
  }
};
