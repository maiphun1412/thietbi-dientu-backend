// controllers/shipperController.js
const { sql, getPool } = require('../config/db');

const toInt = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
};
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** parse 'true' | 'false' | '1' | '0' | boolean */
const parseBoolQuery = (v) => {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
  }
  return undefined;
};

const getUserIdFromToken = (u) =>
  Number(u?.UserID ?? u?.userID ?? u?.Id ?? u?.id ?? u?.userId);

/* =========================
   LIST
========================= */
const list = async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const page = clamp(toInt(req.query.page, 1), 1, 10000);
    const size = clamp(toInt(req.query.size, 20), 1, 100);
    const filterActive = parseBoolQuery(req.query.isActive);

    const p = await getPool();
    const reqDb = p
      .request()
      .input('q', sql.NVarChar(200), `%${q}%`)
      .input('offset', sql.Int, (page - 1) * size)
      .input('size', sql.Int, size);

    let filter = '';
    if (filterActive === true || filterActive === false) {
      filter = ' AND s.IsActive = @isActive ';
      reqDb.input('isActive', sql.Bit, filterActive);
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

    return res.json({
      items: rs.recordsets[0],
      total: rs.recordsets[1][0].total,
      page,
      size,
    });
  } catch (e) {
    console.error('[shipperController.list]', e);
    return res.status(500).json({ message: 'Lỗi lấy danh sách shipper' });
  }
};

/* =========================
   DETAIL
========================= */
const detail = async (req, res) => {
  try {
    const id = toInt(req.params.id, 0);
    const p = await getPool();
    const r = await p
      .request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM dbo.Shippers WHERE ShipperID=@id`);
    if (!r.recordset[0]) return res.status(404).json({ message: 'Không tìm thấy' });
    return res.json(r.recordset[0]);
  } catch (e) {
    console.error('[shipperController.detail]', e);
    return res.status(500).json({ message: 'Lỗi lấy chi tiết' });
  }
};

/* =========================
   CREATE
========================= */
const create = async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.Name || '').trim();
    if (!name) {
      return res.status(400).json({ message: 'Tên shipper là bắt buộc' });
    }
    const p = await getPool();
    const r = await p
      .request()
      .input('Name', sql.NVarChar(200), name)
      .input('Phone', sql.NVarChar(50), body.Phone || null)
      .input('Vehicle', sql.NVarChar(100), body.Vehicle || null)
      .input('LicensePlate', sql.NVarChar(50), body.LicensePlate || null)
      .input('Note', sql.NVarChar(sql.MAX), body.Note || null)
      .input('IsActive', sql.Bit, body.IsActive ?? true)
      .input('UserID', sql.Int, body.UserID || null)
      .query(`
        INSERT INTO dbo.Shippers(Name, Phone, Vehicle, LicensePlate, Note, IsActive, CreatedAt, UserID)
        OUTPUT INSERTED.*
        VALUES(@Name, @Phone, @Vehicle, @LicensePlate, @Note, @IsActive, SYSUTCDATETIME(), @UserID);
      `);
    return res.status(201).json(r.recordset[0]);
  } catch (e) {
    console.error('[shipperController.create]', e);
    if (e && (e.number === 2627 || e.number === 2601)) {
      return res.status(409).json({ message: 'Thông tin đã tồn tại (trùng khóa/sđt/biển số)' });
    }
    return res.status(400).json({ message: 'Tạo shipper thất bại', detail: e.message });
  }
};

/* =========================
   UPDATE
========================= */
const update = async (req, res) => {
  try {
    const id = toInt(req.params.id, 0);
    const body = req.body || {};

    const p = await getPool();
    const r = await p
      .request()
      .input('id', sql.Int, id)
      .input('Name', sql.NVarChar(200), body.Name)
      .input('Phone', sql.NVarChar(50), body.Phone ?? null)
      .input('Vehicle', sql.NVarChar(100), body.Vehicle ?? null)
      .input('LicensePlate', sql.NVarChar(50), body.LicensePlate ?? null)
      .input('Note', sql.NVarChar(sql.MAX), body.Note ?? null)
      .input('IsActive', sql.Bit, typeof body.IsActive === 'boolean' ? body.IsActive : null)
      .input('UserID', sql.Int, body.UserID ?? null)
      .query(`
        UPDATE dbo.Shippers
        SET Name = COALESCE(@Name, Name),
            Phone = @Phone,
            Vehicle = @Vehicle,
            LicensePlate = @LicensePlate,
            Note = @Note,
            IsActive = COALESCE(@IsActive, IsActive),
            UserID = @UserID
        OUTPUT INSERTED.*
        WHERE ShipperID=@id;
      `);

    if (!r.recordset[0]) return res.status(404).json({ message: 'Không tìm thấy' });
    return res.json(r.recordset[0]);
  } catch (e) {
    console.error('[shipperController.update]', e);
    if (e && (e.number === 2627 || e.number === 2601)) {
      return res.status(409).json({ message: 'Thông tin đã tồn tại (trùng khóa/sđt/biển số)' });
    }
    return res.status(400).json({ message: 'Cập nhật shipper thất bại', detail: e.message });
  }
};

/* =========================
   DELETE
========================= */
const remove = async (req, res) => {
  try {
    const id = toInt(req.params.id, 0);
    const p = await getPool();

    const c = await p
      .request()
      .input('id', sql.Int, id)
      .query(`SELECT COUNT(*) AS c FROM dbo.Orders WHERE AssignedShipperID=@id`);
    if (c.recordset[0].c > 0) {
      return res.status(409).json({ message: 'Không thể xoá: còn đơn đang được gán cho shipper này.' });
    }

    await p.request().input('id', sql.Int, id).query(`DELETE FROM dbo.Shippers WHERE ShipperID=@id`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[shipperController.remove]', e);
    return res.status(400).json({ message: 'Xoá shipper thất bại' });
  }
};

/* =========================
   TOGGLE ACTIVE
========================= */
const toggleActive = async (req, res) => {
  try {
    const id = toInt(req.params.id, 0);
    const p = await getPool();
    const r = await p.request().input('id', sql.Int, id).query(`
      UPDATE dbo.Shippers
      SET IsActive = CASE WHEN IsActive=1 THEN 0 ELSE 1 END
      OUTPUT INSERTED.*
      WHERE ShipperID=@id;
    `);
    if (!r.recordset[0]) return res.status(404).json({ message: 'Không tìm thấy' });
    return res.json(r.recordset[0]);
  } catch (e) {
    console.error('[shipperController.toggleActive]', e);
    return res.status(400).json({ message: 'Đổi trạng thái thất bại' });
  }
};

/* =========================
   SEARCH ACTIVE (dropdown)
========================= */
const searchAll = async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const p = await getPool();
    const r = await p
      .request()
      .input('q', sql.NVarChar(200), `%${q}%`)
      .query(`
        SELECT TOP 50 ShipperID, Name, Phone, Vehicle, LicensePlate
        FROM dbo.Shippers
        WHERE IsActive=1 AND (Name LIKE @q OR Phone LIKE @q OR LicensePlate LIKE @q)
        ORDER BY ShipperID DESC;
      `);
    return res.json(r.recordset);
  } catch (e) {
    console.error('[shipperController.searchAll]', e);
    return res.status(500).json({ message: 'Lỗi tìm shipper' });
  }
};

/* =========================
   SHIPPER – Đơn của tôi
========================= */
const myShipments = async (req, res) => {
  try {
    const userId = getUserIdFromToken(req.user);
    if (!userId) {
      return res.status(400).json({ message: 'Token không có UserID' });
    }

    const p = await getPool();
    const rs = await p
      .request()
      .input('userId', sql.Int, userId)
      .query(`
        ;WITH PayLatest AS (
          SELECT
            p.OrderID,
            p.Method AS PaymentMethod,
            p.Status AS PaymentStatus,
            p.Amount AS PaidAmount
          FROM dbo.Payments p
          JOIN (
            SELECT OrderID, MAX(PaymentID) AS MaxPaymentID
            FROM dbo.Payments
            GROUP BY OrderID
          ) m ON m.OrderID = p.OrderID AND m.MaxPaymentID = p.PaymentID
        )
        SELECT 
          -- ID
          s.ShipmentID        AS ShipmentID,
          o.OrderID           AS OrderID,

          -- Trạng thái + thời gian
          s.Status            AS Status,
          s.ShippedAt         AS ShippedAt,
          s.DeliveredAt       AS DeliveredAt,
          s.CreatedAt         AS ShipmentCreatedAt,
          s.UpdatedAt         AS ShipmentUpdatedAt,

          -- Địa chỉ (từ bảng Addresses)
          addr.Line1          AS Line1,
          addr.Ward           AS Ward,
          addr.District       AS District,
          addr.City           AS City,
          addr.Province       AS Province,
          CASE 
            -- Nếu Line1 đã là địa chỉ đầy đủ (có dấu phẩy) thì dùng luôn, không cộng thêm Ward/District/City nữa
            WHEN addr.Line1 IS NOT NULL AND addr.Line1 <> '' 
                 AND CHARINDEX(',', addr.Line1) > 0
              THEN LTRIM(RTRIM(addr.Line1))
            -- Ngược lại, build địa chỉ từ các cột
            ELSE LTRIM(RTRIM(
              COALESCE(addr.Line1, '') +
              CASE WHEN addr.Ward IS NOT NULL AND addr.Ward <> '' THEN 
                    CASE WHEN addr.Line1 IS NULL OR addr.Line1 = '' THEN addr.Ward ELSE ', ' + addr.Ward END
              ELSE '' END +
              CASE WHEN addr.District IS NOT NULL AND addr.District <> '' THEN ', ' + addr.District ELSE '' END +
              CASE WHEN addr.City IS NOT NULL AND addr.City <> '' THEN ', ' + addr.City ELSE '' END +
              CASE 
                WHEN addr.Province IS NOT NULL AND addr.Province <> '' 
                     AND (addr.City IS NULL OR addr.City = '' OR LOWER(addr.City) <> LOWER(addr.Province))
                  THEN ', ' + addr.Province
                ELSE ''
              END
            ))
          END                  AS ShippingAddress,

          -- Đơn hàng
          o.Total             AS TotalAmount,

          -- Khách hàng
          c.FullName          AS CustomerName,
          c.Phone             AS CustomerPhone,
          c.Email             AS CustomerEmail,

          -- Thanh toán
          pay.PaymentMethod   AS PaymentMethod,
          pay.PaymentStatus   AS PaymentStatus,
          pay.PaidAmount      AS PaidAmount,

          -- Số tiền cần thu
          CASE 
            WHEN pay.PaymentMethod IN ('MOMO','CARD','ATM','VNPAY','BANK','TRANSFER')
                 AND pay.PaymentStatus = 'PAID'
              THEN 0
            ELSE o.Total - ISNULL(pay.PaidAmount, 0)
          END AS AmountToCollect
        FROM dbo.Shipments s
        JOIN dbo.Orders   o   ON o.OrderID    = s.OrderID
        JOIN dbo.Shippers sh  ON sh.ShipperID = s.ShipperID
        JOIN dbo.Customers c  ON c.CustomerID = o.CustomerID
        LEFT JOIN dbo.Addresses addr ON addr.AddressID = o.AddressID
        LEFT JOIN PayLatest pay ON pay.OrderID = o.OrderID
        WHERE sh.UserID = @userId
        ORDER BY s.UpdatedAt DESC, s.ShipmentID DESC;
      `);

    if (rs.recordset[0]) {
      console.log('[myShipments first row]', rs.recordset[0]);
    }

    return res.json(rs.recordset);
  } catch (e) {
    console.error('[shipperController.myShipments]', e);
    return res.status(500).json({ message: 'Lỗi lấy đơn của shipper' });
  }
};


/* =========================
   (BỔ SUNG) SET ACTIVE / LOCATION
========================= */
const setActive = async (req, res) => {
  try {
    const id = toInt(req.params.id, 0);
    const isActiveParsed = parseBoolQuery(req.body?.isActive);
    if (isActiveParsed === undefined) {
      return res.status(400).json({ message: 'Thiếu hoặc sai trường isActive' });
    }
    const p = await getPool();
    await p.request()
      .input('id', sql.Int, id)
      .input('isActive', sql.Bit, isActiveParsed)
      .query(`UPDATE dbo.Shippers SET IsActive=@isActive WHERE ShipperID=@id;`);
    return res.json({ id, isActive: !!isActiveParsed });
  } catch (e) {
    console.error('[shipperController.setActive]', e);
    return res.status(400).json({ message: 'Đổi trạng thái thất bại' });
  }
};

const upsertLocation = async (req, res) => {
  try {
    const id  = toInt(req.params.id, 0);
    const lat = req.body?.lat;
    const lng = req.body?.lng;

    if (lat == null || lng == null) {
      return res.status(400).json({ message: 'Thiếu lat/lng' });
    }

    const p = await getPool();
    await p.request()
      .input('id',  sql.Int, id)
      .input('lat', sql.Decimal(9, 6), lat)
      .input('lng', sql.Decimal(9, 6), lng)
      .query(`
        MERGE dbo.ShipperLocation AS t
        USING (SELECT @id AS ShipperID, @lat AS Latitude, @lng AS Longitude) AS s
        ON (t.ShipperID = s.ShipperID)
        WHEN MATCHED THEN
          UPDATE SET Latitude = s.Latitude, Longitude = s.Longitude, UpdatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (ShipperID, Latitude, Longitude) VALUES (s.ShipperID, s.Latitude, s.Longitude);
      `);
    return res.json({ id, lat: Number(lat), lng: Number(lng) });
  } catch (e) {
    console.error('[shipperController.upsertLocation]', e);
    return res.status(400).json({ message: 'Cập nhật vị trí thất bại' });
  }
};

const getLocation = async (req, res) => {
  try {
    const id = toInt(req.params.id, 0);
    const p = await getPool();
    const r = await p.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT ShipperID, Latitude, Longitude, UpdatedAt
        FROM dbo.ShipperLocation
        WHERE ShipperID=@id
      `);
    return res.json(r.recordset[0] || null);
  } catch (e) {
    console.error('[shipperController.getLocation]', e);
    return res.status(500).json({ message: 'Lỗi lấy vị trí shipper' });
  }
};

module.exports = {
  list,
  detail,
  create,
  update,
  remove,
  toggleActive,
  searchAll,
  myShipments,
  setActive,
  upsertLocation,
  getLocation,
};
