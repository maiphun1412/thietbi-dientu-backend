// controllers/addressController.js
const { getPool, sql } = require('../config/db');

/* Helper: lấy field, chấp nhận camelCase & PascalCase */
const pick = (b, camel, pascal) => b[camel] ?? b[pascal] ?? null;

const getMyAddresses = async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('UserID', sql.Int, req.user.id)
      .query(`
        SELECT AddressID, UserID, FullName, Phone, Line1, City, District, Ward, Province, IsDefault
        FROM dbo.Addresses
        WHERE UserID = @UserID
        ORDER BY AddressID DESC
      `);
    res.json(r.recordset);
  } catch (e) {
    res.status(500).json({ message: 'Lỗi lấy địa chỉ', error: e.message });
  }
};

const addAddress = async (req, res) => {
  try {
    const b = req.body;

    // Nhận cả 2 kiểu key
    const fullName  = pick(b, 'fullName',  'FullName');
    const phone     = pick(b, 'phone',     'Phone');
    // chấp nhận 'street' hoặc 'line1' / 'Line1'
    const line1     = b.street ?? pick(b, 'line1', 'Line1');
    const ward      = pick(b, 'ward',      'Ward');
    const district  = pick(b, 'district',  'District');
    const city      = pick(b, 'city',      'City') ?? pick(b, 'province', 'Province'); // fallback
    const province  = pick(b, 'province',  'Province');
    const isDefault = (b.isDefault ?? b.IsDefault) ?? false;

    // Validate tối thiểu (trả 400 thay vì 500)
    if (!fullName || !phone || !line1) {
      return res.status(400).json({ message: 'Thiếu fullName/phone/line1' });
    }

    const pool = await getPool();
    const r = await pool.request()
      .input('UserID',   sql.Int, req.user.id)
      .input('FullName', sql.NVarChar, fullName)
      .input('Phone',    sql.NVarChar, phone)
      .input('Line1',    sql.NVarChar, line1)
      .input('City',     sql.NVarChar, city)
      .input('District', sql.NVarChar, district)
      .input('Ward',     sql.NVarChar, ward)
      .input('Province', sql.NVarChar, province)
      .input('IsDefault', sql.Bit, !!isDefault)
      .query(`
        INSERT INTO dbo.Addresses (UserID, FullName, Phone, Line1, City, District, Ward, Province, IsDefault, CreatedAt)
        OUTPUT inserted.*
        VALUES (@UserID, @FullName, @Phone, @Line1, @City, @District, @Ward, @Province, @IsDefault, GETDATE())
      `);

    res.status(201).json(r.recordset[0]);
  } catch (e) {
    res.status(500).json({ message: 'Lỗi thêm địa chỉ', error: e.message });
  }
};

const updateAddress = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;

    const fullName  = pick(b, 'fullName',  'FullName');
    const phone     = pick(b, 'phone',     'Phone');
    const line1     = b.street ?? pick(b, 'line1', 'Line1');
    const ward      = pick(b, 'ward',      'Ward');
    const district  = pick(b, 'district',  'District');
    const city      = pick(b, 'city',      'City') ?? pick(b, 'province', 'Province');
    const province  = pick(b, 'province',  'Province');
    const isDefault = (b.isDefault ?? b.IsDefault);

    const pool = await getPool();
    const r = await pool.request()
      .input('AddressID', sql.Int, id)
      .input('UserID',    sql.Int, req.user.id)
      .input('FullName',  sql.NVarChar, fullName)
      .input('Phone',     sql.NVarChar, phone)
      .input('Line1',     sql.NVarChar, line1)
      .input('City',      sql.NVarChar, city)
      .input('District',  sql.NVarChar, district)
      .input('Ward',      sql.NVarChar, ward)
      .input('Province',  sql.NVarChar, province)
      .input('IsDefault', sql.Bit, typeof isDefault === 'boolean' ? isDefault : null)
      .query(`
        UPDATE dbo.Addresses
        SET
          FullName = COALESCE(@FullName, FullName),
          Phone    = COALESCE(@Phone, Phone),
          Line1    = COALESCE(@Line1, Line1),
          City     = COALESCE(@City, City),
          District = COALESCE(@District, District),
          Ward     = COALESCE(@Ward, Ward),
          Province = COALESCE(@Province, Province),
          IsDefault= COALESCE(@IsDefault, IsDefault),
          UpdatedAt = GETDATE()
        OUTPUT inserted.*
        WHERE AddressID = @AddressID AND UserID = @UserID;
      `);

    if (!r.recordset[0]) return res.status(404).json({ message: 'Address not found' });
    res.json(r.recordset[0]);
  } catch (e) {
    res.status(500).json({ message: 'Lỗi cập nhật địa chỉ', error: e.message });
  }
};

const deleteAddress = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pool = await getPool();
    const r = await pool.request()
      .input('AddressID', sql.Int, id)
      .input('UserID',    sql.Int, req.user.id)
      .query(`
        DELETE FROM dbo.Addresses
        OUTPUT deleted.*
        WHERE AddressID = @AddressID AND UserID = @UserID;
      `);
    if (!r.recordset[0]) return res.status(404).json({ message: 'Address not found' });
    res.json({ message: 'Deleted', data: r.recordset[0] });
  } catch (e) {
    res.status(500).json({ message: 'Lỗi xoá địa chỉ', error: e.message });
  }
};

module.exports = { getMyAddresses, addAddress, updateAddress, deleteAddress };
