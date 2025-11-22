// controllers/shipmentController.js
const { sql, getPool } = require('../config/db');

const ok = (res, data) => res.json({ ok: true, data });
const bad = (res, e) => {
  console.error('[shipmentController]', e);
  res
    .status(400)
    .json({ ok: false, message: e && e.message ? e.message : 'Internal Error' });
};

const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? d : n;
};

/* ---------------------------------------------------------
   MAPPING TRẠNG THÁI
   - Shipments.Status: LƯU TIẾNG VIỆT (pass CHECK)
   - Orders.Status:    LƯU TIẾNG VIỆT (pass CHECK)
   - Socket/event:     gửi kèm statusU (EN UPPER) nếu FE còn cần
--------------------------------------------------------- */

const toUpperNoAccent = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

const VN = {
  CHO_GIAO: 'Chờ giao',
  DANG_GIAO: 'Đang giao',
  DA_GIAO: 'Đã giao',
  DA_HUY: 'Đã hủy',
};

const ORDER_VN = {
  PENDING: 'Chờ xử lý',
  PROCESSING: 'Đang xử lý',
  SHIPPED: 'Đang giao',
  COMPLETED: 'Đã giao',
  CANCELLED: 'Đã hủy',
};

// Nhận EN/VN bất kỳ -> { shipVN, orderU, orderVN }
const mapAnyToStatuses = (raw) => {
  const u = toUpperNoAccent(raw);

  // ====== TRẠNG THÁI ĐẶC BIỆT CHO SHIPPER ======
  // Liên hệ khách hàng không thành công
  if (
    u === 'CONTACT_FAILED' ||
    (u.includes('LIEN HE') && u.includes('KHACH') && u.includes('KHONG')) ||
    u.includes('GOI KHONG DUOC')
  ) {
    // đơn vẫn đang giao, không huỷ
    return { shipVN: VN.DANG_GIAO, orderU: 'SHIPPED', orderVN: ORDER_VN.SHIPPED };
  }

  // Khách hẹn giao lại (mai / lần sau)
  if (
    u === 'RESCHEDULE' ||
    (u.includes('HEN') && (u.includes('MAI') || u.includes('NGAY MAI') || u.includes('LAN SAU')))
  ) {
    // vẫn coi là đang giao
    return { shipVN: VN.DANG_GIAO, orderU: 'SHIPPED', orderVN: ORDER_VN.SHIPPED };
  }

  // Khách không nhận đơn
  if (
    u === 'CUSTOMER_REFUSED' ||
    (u.includes('KHACH') && u.includes('KHONG NHAN'))
  ) {
    // xem như đơn huỷ
    return { shipVN: VN.DA_HUY, orderU: 'CANCELLED', orderVN: ORDER_VN.CANCELLED };
  }

  // ====== CÁC CASE CŨ (GIỮ NGUYÊN) ======
  if (u.includes('DELIVER') || u.includes('DA GIAO') || u === 'COMPLETED') {
    return { shipVN: VN.DA_GIAO, orderU: 'COMPLETED', orderVN: ORDER_VN.COMPLETED };
  }

  if (u.includes('CANCEL') || u.includes('HUY')) {
    return { shipVN: VN.DA_HUY, orderU: 'CANCELLED', orderVN: ORDER_VN.CANCELLED };
  }

  if (
    u.includes('SHIP') ||
    u.includes('IN TRANSIT') ||
    u.includes('PICK') ||
    u.includes('OUT FOR DELIVERY') ||
    u.includes('DANG GIAO') ||
    u === 'SHIPPED'
  ) {
    return { shipVN: VN.DANG_GIAO, orderU: 'SHIPPED', orderVN: ORDER_VN.SHIPPED };
  }

  // mặc định coi như đã gán, đang xử lý
  return { shipVN: VN.CHO_GIAO, orderU: 'PROCESSING', orderVN: ORDER_VN.PROCESSING };
};

// Orders.Status (EN UPPER) -> tiếng Việt (ghi lịch sử)
const toHistoryVN = (statusUpper) => {
  switch (String(statusUpper || '').toUpperCase()) {
    case 'PENDING':
      return ORDER_VN.PENDING;
    case 'PROCESSING':
      return ORDER_VN.PROCESSING;
    case 'SHIPPED':
      return ORDER_VN.SHIPPED;
    case 'COMPLETED':
      return ORDER_VN.COMPLETED;
    case 'CANCELLED':
      return ORDER_VN.CANCELLED;
    default:
      return ORDER_VN.PENDING;
  }
};

// Tự sinh Note tiếng Việt cho các loại đặc biệt (nếu FE không truyền note)
const autoNoteFromRawStatus = (raw) => {
  const u = toUpperNoAccent(raw || '');
  if (
    u === 'CONTACT_FAILED' ||
    (u.includes('LIEN HE') && u.includes('KHACH') && u.includes('KHONG')) ||
    u.includes('GOI KHONG DUOC')
  ) {
    return 'Liên hệ khách hàng không thành công';
  }
  if (
    u === 'RESCHEDULE' ||
    (u.includes('HEN') && (u.includes('MAI') || u.includes('NGAY MAI') || u.includes('LAN SAU')))
  ) {
    return 'Khách hẹn giao lại';
  }
  if (
    u === 'CUSTOMER_REFUSED' ||
    (u.includes('KHACH') && u.includes('KHONG NHAN'))
  ) {
    return 'Khách không nhận đơn';
  }
  return null;
};

/* =========================================================
   GET /api/shipments
========================================================= */
exports.listShipments = async (req, res) => {
  try {
    const status = (req.query.status || '').toString().trim() || null; // filter theo VN
    const pool = await getPool();
    const r = await pool
      .request()
      .input('status', sql.NVarChar(50), status)
      .query(`
        SELECT
          s.ShipmentID,
          s.OrderID,
          s.ShipperID,
          s.Carrier,
          s.TrackingCode,
          s.ShippingFee,
          s.Status,
          s.ShippedAt,
          s.DeliveredAt,
          s.Note,
          s.CreatedAt,
          s.UpdatedAt,

          -- Thêm thông tin từ Orders / Users / Addresses
          o.Status          AS OrderStatus,
          o.Total           AS TotalAmount,
          u.FullName        AS CustomerName,
          u.Phone           AS CustomerPhone,
          u.Email           AS CustomerEmail,
          a.Line1,
          a.Ward,
          a.District,
          a.City,
          a.Province,

          sh.Name           AS ShipperName
        FROM dbo.Shipments s
        LEFT JOIN dbo.Orders    o ON o.OrderID    = s.OrderID
        LEFT JOIN dbo.Users     u ON u.UserID     = o.CustomerID
        LEFT JOIN dbo.Addresses a ON a.AddressID = o.AddressID
        LEFT JOIN dbo.Shippers  sh ON sh.ShipperID = s.ShipperID
        WHERE (@status IS NULL OR s.Status = @status)
        ORDER BY s.UpdatedAt DESC, s.ShipmentID DESC;
      `);

    return ok(res, r.recordset);
  } catch (e) {
    return bad(res, e);
  }
};

/* =========================================================
   POST /api/orders/:orderId/assign-shipper
========================================================= */
exports.assignShipper = async (req, res) => {
  const io = req.app.get('io');
  const orderId = toInt(req.params.orderId || req.params.id, 0);
  const shipperId = toInt(req.body && req.body.shipperId, 0);

  if (!shipperId) return exports.unassignShipper(req, res);
  if (!orderId || !shipperId) return bad(res, new Error('orderId/shipperId invalid'));

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // check shipper
    const chk = await new sql.Request(tx)
      .input('sid', sql.Int, shipperId)
      .query(`SELECT ShipperID, IsActive FROM dbo.Shippers WHERE ShipperID=@sid`);
    const shipper = chk.recordset[0];
    if (!shipper) throw new Error('Shipper không tồn tại');
    if (shipper.IsActive === false) throw new Error('Shipper đang tạm ngưng hoạt động');

    // MERGE Shipments: dùng "Đang giao"
    const merged = await new sql.Request(tx)
      .input('orderId', sql.Int, orderId)
      .input('shipperId', sql.Int, shipperId)
      .input('stVN', sql.NVarChar(50), 'Đang giao')
      .query(`
        DECLARE @op TABLE (ShipmentID INT);

        MERGE dbo.Shipments AS t
        USING (SELECT @orderId AS OrderID) s
          ON t.OrderID = s.OrderID
        WHEN MATCHED THEN
          UPDATE SET ShipperID=@shipperId,
                     Status = COALESCE(NULLIF(t.Status,''), @stVN),
                     UpdatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (OrderID, ShipperID, Status, CreatedAt, UpdatedAt)
          VALUES (@orderId, @shipperId, @stVN, SYSUTCDATETIME(), SYSUTCDATETIME())
        OUTPUT inserted.ShipmentID INTO @op;

        SELECT ShipmentID FROM @op;
      `);
    const shipmentId = merged.recordset[0].ShipmentID;

    // cập nhật Orders -> "Đang xử lý" + AssignedShipperID
    await new sql.Request(tx)
      .input('oid', sql.Int, orderId)
      .input('sid', sql.Int, shipperId)
      .input('stOrderVN', sql.NVarChar(50), 'Đang xử lý')
      .query(`
        UPDATE dbo.Orders
          SET Status=@stOrderVN, UpdatedAt=SYSUTCDATETIME()
        WHERE OrderID=@oid;

        IF COL_LENGTH('dbo.Orders','AssignedShipperID') IS NOT NULL
          UPDATE dbo.Orders
            SET AssignedShipperID=@sid, AssignedAt=SYSUTCDATETIME()
          WHERE OrderID=@oid;
      `);

    // ghi lịch sử
    await new sql.Request(tx)
      .input('oid', sql.Int, orderId)
      .query(`
        INSERT INTO dbo.OrderStatusHistory (OrderID, OldStatus, NewStatus, ChangedAt, ChangedBy, Note)
        VALUES (@oid, N'Đang xử lý', N'Đang xử lý', SYSUTCDATETIME(), NULL, N'Gán shipper');
      `);

    // LẤY LẠI SHIPMENT CÓ JOIN SHIPPERS ĐỂ TRẢ VỀ
    const joined = await new sql.Request(tx)
      .input('oid', sql.Int, orderId)
      .query(`
        SELECT TOP 1
          s.ShipmentID, s.OrderID, s.ShipperID, s.Status, s.Note,
          s.CreatedAt, s.UpdatedAt,
          sh.Name AS ShipperName, sh.Phone AS ShipperPhone,
          sh.LicensePlate, sh.Vehicle
        FROM dbo.Shipments s
        LEFT JOIN dbo.Shippers sh ON sh.ShipperID = s.ShipperID
        WHERE s.OrderID=@oid
        ORDER BY s.ShipmentID DESC
      `);

    await tx.commit();

    if (io) {
      io
        .to('admins')
        .emit('order_status_updated', {
          orderId,
          statusU: 'PROCESSING',
          statusVN: 'Đang xử lý',
          note: 'Gán shipper',
        });
      io
        .to(`order_${orderId}`)
        .emit('order_status_updated', {
          orderId,
          statusU: 'PROCESSING',
          statusVN: 'Đang xử lý',
          note: 'Gán shipper',
        });
    }

    return ok(res, { shipmentId, shipment: joined.recordset[0] });
  } catch (e) {
    try {
      await tx.rollback();
    } catch {}
    return bad(res, e);
  }
};

/* =========================================================
   POST /api/orders/:orderId/unassign-shipper
========================================================= */
exports.unassignShipper = async (req, res) => {
  const io = req.app.get('io');
  const orderId = toInt(req.params.orderId || req.params.id, 0);
  if (!orderId) return bad(res, new Error('orderId required'));

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    const cur = await new sql.Request(tx)
      .input('oid', sql.Int, orderId)
      .query(`
        SELECT TOP 1 ShipmentID, Status
        FROM dbo.Shipments WHERE OrderID=@oid
        ORDER BY ShipmentID DESC
      `);

    const shipment = cur.recordset[0] || null;

    if (shipment) {
      await new sql.Request(tx)
        .input('sid', sql.Int, shipment.ShipmentID)
        .input('stVN', sql.NVarChar(50), VN.CHO_GIAO)
        .query(`
          UPDATE dbo.Shipments
          SET ShipperID = NULL,
              Status    = @stVN,
              UpdatedAt = SYSUTCDATETIME()
          WHERE ShipmentID=@sid;
        `);
    }

    await new sql.Request(tx)
      .input('oid', sql.Int, orderId)
      .input('stOrderVN', sql.NVarChar(50), ORDER_VN.PROCESSING)
      .query(`
        IF COL_LENGTH('dbo.Orders','AssignedShipperID') IS NOT NULL
          UPDATE dbo.Orders
            SET AssignedShipperID=NULL, AssignedAt=NULL
          WHERE OrderID=@oid;

        UPDATE dbo.Orders SET Status=@stOrderVN, UpdatedAt=SYSUTCDATETIME()
        WHERE OrderID=@oid;
      `);

    await new sql.Request(tx)
      .input('oid', sql.Int, orderId)
      .query(`
        INSERT INTO dbo.OrderStatusHistory (OrderID, OldStatus, NewStatus, ChangedAt, ChangedBy, Note)
        VALUES (@oid, N'Đang xử lý', N'Đang xử lý', SYSUTCDATETIME(), NULL, N'Huỷ gán shipper');
      `);

    await tx.commit();

    if (io) {
      io
        .to('admins')
        .emit('order_status_updated', {
          orderId,
          statusU: 'PROCESSING',
          statusVN: ORDER_VN.PROCESSING,
          note: 'Huỷ gán shipper',
        });
      io
        .to(`order_${orderId}`)
        .emit('order_status_updated', {
          orderId,
          statusU: 'PROCESSING',
          statusVN: ORDER_VN.PROCESSING,
          note: 'Huỷ gán shipper',
        });
    }

    return ok(res, { orderId, unassigned: true });
  } catch (e) {
    try {
      await tx.rollback();
    } catch {}
    return bad(res, e);
  }
};

/* =========================================================
   PATCH /api/shipments/:id/status
========================================================= */
exports.updateShipmentStatus = async (req, res) => {
  const io = req.app.get('io');
  const rawId = toInt(req.params.id, 0);
  const status = (req.body && req.body.status) || '';
  let note = (req.body && req.body.note) || null; // cho phép FE override
  const userId = req.body && req.body.userId ? toInt(req.body.userId, null) : null;

  if (!rawId || !status) return bad(res, new Error('shipmentId/status required'));

  // Nếu không có note → tự sinh cho các status đặc biệt
  if (!note) {
    note = autoNoteFromRawStatus(status);
  }

  const { shipVN: statusVN, orderU, orderVN } = mapAnyToStatuses(status);

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // 1) Thử coi rawId là ShipmentID
    let cur = await new sql.Request(tx)
      .input('sid', sql.Int, rawId)
      .query(`
        SELECT s.ShipmentID, s.OrderID, s.Status AS ShipStatus, o.Status AS OrderStatus
        FROM dbo.Shipments s
        LEFT JOIN dbo.Orders o ON o.OrderID = s.OrderID
        WHERE s.ShipmentID=@sid
      `);

    let row = cur.recordset[0];

    // 2) Nếu không có, coi rawId là OrderID → lấy shipment mới nhất của đơn đó
    if (!row) {
      cur = await new sql.Request(tx)
        .input('oid', sql.Int, rawId)
        .query(`
          SELECT TOP 1 s.ShipmentID, s.OrderID, s.Status AS ShipStatus, o.Status AS OrderStatus
          FROM dbo.Shipments s
          LEFT JOIN dbo.Orders o ON o.OrderID = s.OrderID
          WHERE s.OrderID=@oid
          ORDER BY s.ShipmentID DESC
        `);
      row = cur.recordset[0];
    }

    if (!row) throw new Error('Shipment not found');

    const shipmentId = row.ShipmentID;
    const orderId = row.OrderID;
    const oldOrderVN = row.OrderStatus || row.ShipStatus || ORDER_VN.PENDING;
    const oldOrderU =
      Object.entries(ORDER_VN).find(([, v]) => v === oldOrderVN)?.[0] || 'PENDING';

    // cập nhật Shipments -> VN
    await new sql.Request(tx)
      .input('sid', sql.Int, shipmentId)
      .input('statusVN', sql.NVarChar(50), statusVN)
      .input('note', sql.NVarChar(sql.MAX), note)
      .query(`
        UPDATE dbo.Shipments
        SET Status=@statusVN,
            ShippedAt   = CASE WHEN @statusVN = N'${VN.DANG_GIAO}' AND ShippedAt IS NULL THEN SYSUTCDATETIME() ELSE ShippedAt END,
            DeliveredAt = CASE WHEN @statusVN = N'${VN.DA_GIAO}' THEN SYSUTCDATETIME() ELSE DeliveredAt END,
            UpdatedAt   = SYSUTCDATETIME(),
            Note        = COALESCE(@note, Note)
        WHERE ShipmentID=@sid;
      `);

    // cập nhật Orders.Status (VN) + Note (nếu có)
    await new sql.Request(tx)
      .input('oid', sql.Int, orderId)
      .input('orderStatusVN', sql.NVarChar(50), orderVN)
      .input('note', sql.NVarChar(sql.MAX), note)
      .query(`
        UPDATE dbo.Orders
        SET Status   = @orderStatusVN,
            UpdatedAt = SYSUTCDATETIME(),
            Note      = COALESCE(@note, Note)
        WHERE OrderID=@oid;
      `);

    // lịch sử (VN)
    await new sql.Request(tx)
      .input('oid', sql.Int, orderId)
      .input('oldS', sql.NVarChar(100), toHistoryVN(oldOrderU))
      .input('newS', sql.NVarChar(100), toHistoryVN(orderU))
      .input('by', sql.Int, userId)
      .input('note', sql.NVarChar(sql.MAX), note)
      .query(`
        INSERT INTO dbo.OrderStatusHistory (OrderID, OldStatus, NewStatus, ChangedAt, ChangedBy, Note)
        VALUES (@oid, @oldS, @newS, SYSUTCDATETIME(), @by, @note);
      `);

    // CỘNG SOLD NẾU LẦN ĐẦU CHUYỂN SANG COMPLETED
    if (oldOrderU !== 'COMPLETED' && orderU === 'COMPLETED') {
      await new sql.Request(tx)
        .input('OrderID', sql.Int, orderId)
        .query(`
          ;WITH S AS (
            SELECT ProductID, SUM(Quantity) AS Qty
            FROM dbo.OrderItems
            WHERE OrderID = @OrderID
            GROUP BY ProductID
          )
          UPDATE p
          SET p.Sold = ISNULL(p.Sold,0) + s.Qty
          FROM dbo.Products p
          JOIN S s ON s.ProductID = p.ProductID;
        `);
    }

    await tx.commit();

    if (io) {
      io
        .to('admins')
        .emit('order_status_updated', {
          orderId,
          statusU: orderU,
          statusVN: orderVN,
          note: note || null,
        });
      io
        .to(`order_${orderId}`)
        .emit('order_status_updated', {
          orderId,
          statusU: orderU,
          statusVN: orderVN,
          note: note || null,
        });
    }

    return ok(res, {
      orderId,
      shipmentId,
      status: statusVN,
      orderStatusVN: orderVN,
      orderStatusU: orderU,
      note: note || null,
    });
  } catch (e) {
    try {
      await tx.rollback();
    } catch {}
    return bad(res, e);
  }
};

/* =========================================================
   POST /api/shipments/:id/track
========================================================= */
exports.appendTracking = async (req, res) => {
  const io = req.app.get('io');
  const shipmentId = toInt(req.params.id, 0);
  const lat = req.body ? req.body.lat : null;
  const lng = req.body ? req.body.lng : null;
  let note = req.body ? req.body.note || null : null;
  const raw = req.body ? req.body.status || null : null;

  if (!shipmentId || lat == null || lng == null) {
    return bad(res, new Error('shipmentId/lat/lng required'));
  }

  try {
    const pool = await getPool();

    const cur = await pool
      .request()
      .input('sid', sql.Int, shipmentId)
      .query(`SELECT OrderID FROM dbo.Shipments WHERE ShipmentID=@sid`);
    if (!cur.recordset[0]) throw new Error('Shipment not found');

    const orderId = cur.recordset[0].OrderID;

    const ordRow = await pool
      .request()
      .input('oid', sql.Int, orderId)
      .query(`SELECT Status FROM dbo.Orders WHERE OrderID=@oid`);
    const oldOrderVN = ordRow.recordset[0]?.Status || ORDER_VN.PENDING;
    const oldOrderU =
      Object.entries(ORDER_VN).find(([, v]) => v === oldOrderVN)?.[0] || 'PENDING';

    const mapped = mapAnyToStatuses(raw || VN.DANG_GIAO);
    const stVN = mapped.shipVN;

    // nếu không có note mà status là mấy loại đặc biệt → auto-note
    if (!note) {
      note = autoNoteFromRawStatus(raw || stVN) || null;
    }

    await pool
      .request()
      .input('sid', sql.Int, shipmentId)
      .input('lat', sql.Decimal(9, 6), lat)
      .input('lng', sql.Decimal(9, 6), lng)
      .input('note', sql.NVarChar(sql.MAX), note)
      .input('stVN', sql.NVarChar(50), stVN)
      .query(`
        INSERT INTO dbo.ShipmentTracking (ShipmentID, Status, Note, Latitude, Longitude, CreatedAt)
        VALUES (@sid, @stVN, @note, @lat, @lng, SYSUTCDATETIME());
      `);

    await pool
      .request()
      .input('sid', sql.Int, shipmentId)
      .input('stVN', sql.NVarChar(50), stVN)
      .query(
        `UPDATE dbo.Shipments SET Status=@stVN, UpdatedAt=SYSUTCDATETIME() WHERE ShipmentID=@sid`
      );

    const mappedU = mapped.orderU;
    const mappedVN = mapped.orderVN;
    const mappedHistVN = toHistoryVN(mappedU);

    await pool
      .request()
      .input('oid', sql.Int, orderId)
      .input('sid', sql.Int, shipmentId)
      .input('orderVN', sql.NVarChar(50), mappedVN)
      .input('mappedHistVN', sql.NVarChar(50), mappedHistVN)
      .input('note', sql.NVarChar(sql.MAX), note)
      .query(`
        INSERT INTO dbo.OrderStatusHistory (OrderID, OldStatus, NewStatus, ChangedAt, ChangedBy, Note)
        VALUES (@oid, N'Đang giao', @mappedHistVN, SYSUTCDATETIME(), NULL, @note);

        UPDATE dbo.Orders
        SET Status   = @orderVN,
            UpdatedAt = SYSUTCDATETIME(),
            Note      = COALESCE(@note, Note)
        WHERE OrderID=@oid;

        IF (@orderVN = N'Đã giao')
          UPDATE dbo.Shipments SET DeliveredAt = SYSUTCDATETIME() WHERE ShipmentID=@sid;
      `);

    // ➕ CỘNG SOLD NẾU LẦN ĐẦU CHUYỂN SANG COMPLETED
    if (oldOrderU !== 'COMPLETED' && mappedU === 'COMPLETED') {
      await pool
        .request()
        .input('OrderID', sql.Int, orderId)
        .query(`
          ;WITH S AS (
            SELECT ProductID, SUM(Quantity) AS Qty
            FROM dbo.OrderItems
            WHERE OrderID = @OrderID
            GROUP BY ProductID
          )
          UPDATE p
          SET p.Sold = ISNULL(p.Sold,0) + s.Qty
          FROM dbo.Products p
          JOIN S s ON s.ProductID = p.ProductID;
        `);
    }

    if (io) {
      io.to('admins').emit('shipment_location', {
        orderId,
        shipmentId,
        lat,
        lng,
        note: note || null,
      });
      io.to(`order_${orderId}`).emit('shipment_location', {
        orderId,
        lat,
        lng,
        note: note || null,
      });
      io
        .to('admins')
        .emit('order_status_updated', {
          orderId,
          statusU: mappedU,
          statusVN: mappedVN,
          note: note || null,
        });
      io
        .to(`order_${orderId}`)
        .emit('order_status_updated', {
          orderId,
          statusU: mappedU,
          statusVN: mappedVN,
          note: note || null,
        });
    }

    return ok(res, { shipmentId });
  } catch (e) {
    return bad(res, e);
  }
};
// LẤY CÁC ĐƠN CỦA SHIPPER ĐANG ĐĂNG NHẬP
// GET /shipper/my-shipments
exports.myShipmentsForCurrentShipper = async (req, res) => {
  try {
    const pool = await getPool();

    // Lấy shipperId từ token
    // tuỳ em lưu thế nào trong middleware, chỉnh lại cho khớp
    const userId = req.user && (req.user.UserID || req.user.userId);
    let shipperId = req.user && (req.user.ShipperID || req.user.shipperId);

    // Nếu token chỉ có userId, map sang bảng Shippers
    if (!shipperId && userId) {
      const r = await pool
        .request()
        .input('uid', sql.Int, userId)
        .query(`
          SELECT TOP 1 ShipperID
          FROM dbo.Shippers
          WHERE UserID = @uid
        `);
      shipperId = r.recordset[0]?.ShipperID || null;
    }

    if (!shipperId) {
      return bad(res, new Error('Không xác định được shipper hiện tại'));
    }

    const result = await pool
      .request()
      .input('sid', sql.Int, shipperId)
      .query(`
        SELECT
          s.ShipmentID,
          s.OrderID,
          s.ShipperID,
          s.ShippingFee,
          s.Status,
          s.Note,
          s.CreatedAt,
          s.UpdatedAt,

          -- Thông tin đơn
          o.Status      AS OrderStatus,
          o.Total       AS TotalAmount,

          -- Thông tin khách
          u.FullName    AS CustomerName,
          u.Phone       AS CustomerPhone,
          u.Email       AS CustomerEmail,

          -- Địa chỉ giao
          a.Line1,
          a.Ward,
          a.District,
          a.City,
          a.Province,
          -- Cho FE dùng key shippingAddress luôn nếu thích
          CONCAT(
            ISNULL(a.Line1, ''),
            CASE WHEN a.Ward IS NULL OR a.Ward = '' THEN '' ELSE ', ' + a.Ward END,
            CASE WHEN a.District IS NULL OR a.District = '' THEN '' ELSE ', ' + a.District END,
            CASE WHEN a.City IS NULL OR a.City = '' THEN '' ELSE ', ' + a.City END,
            CASE WHEN a.Province IS NULL OR a.Province = '' THEN '' ELSE ', ' + a.Province END
          ) AS ShippingAddress

        FROM dbo.Shipments s
        INNER JOIN dbo.Orders    o ON o.OrderID   = s.OrderID
        LEFT  JOIN dbo.Users     u ON u.UserID    = o.CustomerID
        LEFT  JOIN dbo.Addresses a ON a.AddressID = o.AddressID
        WHERE s.ShipperID = @sid
        ORDER BY s.UpdatedAt DESC, s.ShipmentID DESC;
      `);

    return ok(res, result.recordset);
  } catch (e) {
    return bad(res, e);
  }
};


/* =========================================================
   GET /api/orders/:orderId/track
========================================================= */
exports.getOrderTracking = async (req, res) => {
  try {
    const orderId = toInt(req.params.orderId, 0);
    const pool = await getPool();

    const order =
      (
        await pool
          .request()
          .input('oid', sql.Int, orderId)
          .query(`SELECT * FROM dbo.Orders WHERE OrderID=@oid`)
      ).recordset[0] || null;

    const shipment =
      (
        await pool
          .request()
          .input('oid', sql.Int, orderId)
          .query(`
        SELECT TOP 1
          s.ShipmentID, s.OrderID, s.ShipperID, s.Status, s.Note,
          s.CreatedAt, s.UpdatedAt, s.ShippedAt, s.DeliveredAt,
          sh.Name AS ShipperName, sh.Phone AS ShipperPhone,
          sh.LicensePlate, sh.Vehicle
        FROM dbo.Shipments s
        LEFT JOIN dbo.Shippers sh ON sh.ShipperID = s.ShipperID
        WHERE s.OrderID=@oid
        ORDER BY s.ShipmentID DESC
      `)
      ).recordset[0] || null;

    const history = (
      await pool
        .request()
        .input('oid', sql.Int, orderId)
        .query(
          `SELECT * FROM dbo.OrderStatusHistory WHERE OrderID=@oid ORDER BY ChangedAt ASC`
        )
    ).recordset;

    let tracking = [];
    if (shipment) {
      tracking = (
        await pool
          .request()
          .input('sid', sql.Int, shipment.ShipmentID)
          .query(
            `SELECT * FROM dbo.ShipmentTracking WHERE ShipmentID=@sid ORDER BY CreatedAt ASC`
          )
      ).recordset;
    }

    return ok(res, { order, shipment, history, tracking });
  } catch (e) {
    return bad(res, e);
  }
};
