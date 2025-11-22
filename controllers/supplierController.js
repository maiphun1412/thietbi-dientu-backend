// controllers/supplierController.js
const { getPool, sql } = require('../config/db');

// Lấy tất cả nhà cung cấp
const getAllSuppliers = async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT * FROM Suppliers ORDER BY SupplierID');

    res.json(result.recordset);
  } catch (err) {
    console.error('getAllSuppliers error:', err);
    res.status(500).json({
      message: 'Lỗi khi lấy danh sách nhà cung cấp',
      error: err.message,
    });
  }
};

// Thêm nhà cung cấp
const addSupplier = async (req, res) => {
  const { Name, Email, Phone, Address } = req.body;

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('Name', sql.NVarChar, Name)
      .input('Email', sql.NVarChar, Email || null)
      .input('Phone', sql.NVarChar, Phone || null)
      .input('Address', sql.NVarChar, Address || null)
      .query(`
        INSERT INTO Suppliers (Name, Email, Phone, Address)
        OUTPUT INSERTED.*
        VALUES (@Name, @Email, @Phone, @Address)
      `);

    const inserted = result.recordset[0];
    res.status(201).json(inserted);
  } catch (err) {
    console.error('addSupplier error:', err);
    res.status(500).json({
      message: 'Lỗi khi thêm nhà cung cấp',
      error: err.message,
    });
  }
};

// Cập nhật nhà cung cấp
const updateSupplier = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { Name, Email, Phone, Address } = req.body;

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('SupplierID', sql.Int, id)
      .input('Name', sql.NVarChar, Name)
      .input('Email', sql.NVarChar, Email || null)
      .input('Phone', sql.NVarChar, Phone || null)
      .input('Address', sql.NVarChar, Address || null)
      .query(`
        UPDATE Suppliers
        SET Name = @Name,
            Email = @Email,
            Phone = @Phone,
            Address = @Address
        WHERE SupplierID = @SupplierID;

        SELECT * FROM Suppliers WHERE SupplierID = @SupplierID;
      `);

    const updated = result.recordset[0];
    if (!updated) {
      return res.status(404).json({ message: 'Không tìm thấy nhà cung cấp để cập nhật' });
    }

    res.json(updated);
  } catch (err) {
    console.error('updateSupplier error:', err);
    res.status(500).json({
      message: 'Lỗi khi cập nhật nhà cung cấp',
      error: err.message,
    });
  }
};

// Xóa nhà cung cấp
const deleteSupplier = async (req, res) => {
  const id = parseInt(req.params.id, 10);

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('SupplierID', sql.Int, id)
      .query('DELETE FROM Suppliers WHERE SupplierID = @SupplierID');

    if (!result.rowsAffected[0]) {
      return res.status(404).json({ message: 'Không tìm thấy nhà cung cấp để xóa' });
    }

    res.status(204).send();
  } catch (err) {
    console.error('deleteSupplier error:', err);
    res.status(500).json({
      message: 'Lỗi khi xóa nhà cung cấp',
      error: err.message,
    });
  }
};

module.exports = {
  getAllSuppliers,
  addSupplier,
  updateSupplier,
  deleteSupplier,
};
