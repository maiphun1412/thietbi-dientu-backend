const { sql, poolPromise } = require('../config/db');

exports.list = async ({ q = '', page = 1, size = 20, isActive }) => {
  const p = await poolPromise;

  const reqDb = p.request()
    .input('q', sql.NVarChar, `%${q}%`)
    .input('offset', sql.Int, (page - 1) * size)
    .input('size', sql.Int, +size);

  let filter = '';
  if (isActive === true || isActive === false) {
    filter = ' AND s.IsActive = @isActive ';
    reqDb.input('isActive', sql.Bit, isActive);
  }

  const rs = await reqDb.query(`
    WITH sdata AS (
      SELECT 
        s.ShipperID, s.Name, s.Phone, s.Vehicle, s.LicensePlate, s.Note, s.IsActive, s.CreatedAt, s.UserID,
        (SELECT COUNT(*) FROM dbo.Orders o WHERE o.AssignedShipperID = s.ShipperID) AS TotalAssigned
      FROM dbo.Shippers s
      WHERE (s.Name LIKE @q OR s.Phone LIKE @q OR s.LicensePlate LIKE @q) ${filter}
    )
    SELECT * FROM sdata
    ORDER BY ShipperID DESC
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;

    SELECT COUNT(*) AS total
    FROM dbo.Shippers s
    WHERE (s.Name LIKE @q OR s.Phone LIKE @q OR s.LicensePlate LIKE @q) ${filter};
  `);

  return { items: rs.recordsets[0], total: rs.recordsets[1][0].total, page: +page, size: +size };
};

exports.getById = async (id) => {
  const p = await poolPromise;

  const rs = await p.request().input('id', sql.Int, id)
    .query(`SELECT * FROM dbo.Shippers WHERE ShipperID=@id`);
  return rs.recordset[0] || null;
};

exports.create = async (payload) => {
  const p = await poolPromise;

  const r = await p.request()
    .input('Name', sql.NVarChar(200), payload.Name)
    .input('Phone', sql.NVarChar(50), payload.Phone || null)
    .input('Vehicle', sql.NVarChar(100), payload.Vehicle || null)
    .input('LicensePlate', sql.NVarChar(50), payload.LicensePlate || null)
    .input('Note', sql.NVarChar(sql.MAX), payload.Note || null)
    .input('IsActive', sql.Bit, payload.IsActive ?? true)
    .input('UserID', sql.Int, payload.UserID || null) // <-- Users.UserID
    .query(`
      INSERT INTO dbo.Shippers(Name, Phone, Vehicle, LicensePlate, Note, IsActive, CreatedAt, UserID)
      OUTPUT INSERTED.*
      VALUES(@Name, @Phone, @Vehicle, @LicensePlate, @Note, @IsActive, SYSUTCDATETIME(), @UserID);
    `);
  return r.recordset[0];
};

exports.update = async (id, payload) => {
  const p = await poolPromise;

  const r = await p.request()
    .input('id', sql.Int, id)
    .input('Name', sql.NVarChar(200), payload.Name)
    .input('Phone', sql.NVarChar(50), payload.Phone || null)
    .input('Vehicle', sql.NVarChar(100), payload.Vehicle || null)
    .input('LicensePlate', sql.NVarChar(50), payload.LicensePlate || null)
    .input('Note', sql.NVarChar(sql.MAX), payload.Note || null)
    .input('IsActive', sql.Bit, payload.IsActive ?? true)
    .input('UserID', sql.Int, payload.UserID || null) // <-- Users.UserID
    .query(`
      UPDATE dbo.Shippers
      SET Name=@Name, Phone=@Phone, Vehicle=@Vehicle, LicensePlate=@LicensePlate, 
          Note=@Note, IsActive=@IsActive, UserID=@UserID
      OUTPUT INSERTED.*
      WHERE ShipperID=@id;
    `);
  return r.recordset[0];
};

exports.remove = async (id) => {
  const p = await poolPromise;

  const c = await p.request().input('id', sql.Int, id)
    .query(`SELECT COUNT(*) AS c FROM dbo.Orders WHERE AssignedShipperID=@id`);
  if (c.recordset[0].c > 0) {
    const err = new Error('Không thể xoá: còn đơn đang được gán cho shipper này.');
    err.code = 'CONFLICT';
    throw err;
  }
  await p.request().input('id', sql.Int, id)
    .query(`DELETE FROM dbo.Shippers WHERE ShipperID=@id`);
  return true;
};

exports.toggleActive = async (id) => {
 const p = await poolPromise;

  const r = await p.request().input('id', sql.Int, id).query(`
    UPDATE dbo.Shippers
    SET IsActive = CASE WHEN IsActive=1 THEN 0 ELSE 1 END
    OUTPUT INSERTED.*
    WHERE ShipperID=@id;
  `);
  return r.recordset[0];
};

exports.searchActive = async (q = '') => {
  const p = await poolPromise;

  const r = await p.request()
    .input('q', sql.NVarChar, `%${q}%`)
    .query(`
      SELECT TOP 50 ShipperID, Name, Phone, Vehicle, LicensePlate
      FROM dbo.Shippers
      WHERE IsActive=1 AND (Name LIKE @q OR Phone LIKE @q OR LicensePlate LIKE @q)
      ORDER BY ShipperID DESC;
    `);
  return r.recordset;
};
