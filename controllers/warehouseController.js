const { getPool, sql } = require('../config/db');

// Lấy tất cả kho
const getAllWarehouses = async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT * FROM Warehouses ORDER BY WarehouseID');

    res.json(result.recordset);
  } catch (err) {
    console.error('getAllWarehouses error:', err);
    res.status(500).json({
      message: 'Lỗi khi lấy danh sách kho',
      error: err.message,
    });
  }
};

// Thêm kho mới
const addWarehouse = async (req, res) => {
  const { Name, Address, Description } = req.body;

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('Name', sql.NVarChar, Name)
      .input('Address', sql.NVarChar, Address || null)
      .input('Description', sql.NVarChar, Description || null)
      .query(`
        INSERT INTO Warehouses (Name, Address, Description, CreatedAt)
        OUTPUT INSERTED.*
        VALUES (@Name, @Address, @Description, GETDATE())
      `);

    const inserted = result.recordset[0];
    res.status(201).json(inserted);
  } catch (err) {
    console.error('addWarehouse error:', err);
    res.status(500).json({
      message: 'Lỗi khi thêm kho',
      error: err.message,
    });
  }
};

// Cập nhật kho
const updateWarehouse = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { Name, Address, Description } = req.body;

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('WarehouseID', sql.Int, id)
      .input('Name', sql.NVarChar, Name)
      .input('Address', sql.NVarChar, Address || null)
      .input('Description', sql.NVarChar, Description || null)
      .query(`
        UPDATE Warehouses
        SET Name = @Name,
            Address = @Address,
            Description = @Description
        WHERE WarehouseID = @WarehouseID;

        SELECT * FROM Warehouses WHERE WarehouseID = @WarehouseID;
      `);

    const updated = result.recordset[0];
    if (!updated) {
      return res.status(404).json({ message: 'Không tìm thấy kho để cập nhật' });
    }

    res.json(updated);
  } catch (err) {
    console.error('updateWarehouse error:', err);
    res.status(500).json({
      message: 'Lỗi khi cập nhật kho',
      error: err.message,
    });
  }
};

// Xóa kho
const deleteWarehouse = async (req, res) => {
  const id = parseInt(req.params.id, 10);

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('WarehouseID', sql.Int, id)
      .query('DELETE FROM Warehouses WHERE WarehouseID = @WarehouseID');

    if (!result.rowsAffected[0]) {
      return res.status(404).json({ message: 'Không tìm thấy kho để xóa' });
    }

    res.status(204).send();
  } catch (err) {
    console.error('deleteWarehouse error:', err);
    res.status(500).json({
      message: 'Lỗi khi xóa kho',
      error: err.message,
    });
  }
};

module.exports = {
  getAllWarehouses,
  addWarehouse,
  updateWarehouse,
  deleteWarehouse,
};
