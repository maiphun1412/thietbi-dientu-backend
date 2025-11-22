// controllers/orderController.js
const { getPool, sql } = require('../config/db');
const nodemailer = require('nodemailer'); // ⬅️ thêm để gửi mail

/* =================== NOTIFICATION HELPERS (per-user) =================== */
// Ghi DB + emit socket tới đúng user — AN TOÀN khi DB chưa có cột DataJson
async function notifyUser(req, { userId, type, title, message, data }) {
  try {
    const pool = await getPool();

    // Kiểm tra cột DataJson có tồn tại không
    const check = await pool.request()
      .input('table', sql.NVarChar, 'dbo.Notifications')
      .input('column', sql.NVarChar, 'DataJson')
      .query(`
        SELECT COUNT(*) AS Cnt
        FROM sys.columns
        WHERE object_id = OBJECT_ID(@table) AND name = @column
      `);
    const hasDataJson = (check.recordset?.[0]?.Cnt || 0) > 0;

    let noti;
    if (hasDataJson) {
      const rs = await pool.request()
        .input('UserID',   sql.Int, userId)
        .input('Type',     sql.NVarChar(50),  type)
        .input('Title',    sql.NVarChar(255), title)
        .input('Message',  sql.NVarChar(1000), message ?? null)
        .input('DataJson', sql.NVarChar(sql.MAX), data ? JSON.stringify(data) : null)
        .query(`
          INSERT INTO dbo.Notifications(UserID, Type, Title, Message, DataJson)
          OUTPUT INSERTED.*
          VALUES(@UserID, @Type, @Title, @Message, @DataJson)
        `);
      noti = rs.recordset?.[0];
    } else {
      const rs = await pool.request()
        .input('UserID',   sql.Int, userId)
        .input('Type',     sql.NVarChar(50),  type)
        .input('Title',    sql.NVarChar(255), title)
        .input('Message',  sql.NVarChar(1000), message ?? null)
        .query(`
          INSERT INTO dbo.Notifications(UserID, Type, Title, Message)
          OUTPUT INSERTED.*
          VALUES(@UserID, @Type, @Title, @Message)
        `);
      noti = rs.recordset?.[0];
    }

    // emit socket theo map userId -> socketId đã set trong server
    const io = req.app?.get('io');
    const userSockets = req.app?.get('userSockets');
    const sid = userSockets?.get?.(userId);
    if (io && sid && noti) io.to(sid).emit('notification', noti);
  } catch (e) {
    console.error('[notifyUser] ERROR:', e);
  }
}

function pickSomeNames(names, max = 3) {
  const arr = Array.from(new Set(names)).filter(Boolean);
  if (!arr.length) return '';
  if (arr.length <= max) return arr.join(', ');
  return arr.slice(0, max).join(', ') + ` +${arr.length - max} sản phẩm`;
}
/* ======================================================================= */


/* ===== ensureCustomerForUser (local) ===== */
async function ensureCustomerForUser(pool, userId) {
  const rs = await pool.request()
    .input('UserID', sql.Int, userId)
    .query(`SELECT TOP 1 CustomerID FROM dbo.Customers WHERE UserID=@UserID`);
  if (rs.recordset[0]?.CustomerID) return rs.recordset[0].CustomerID;

  const u = await pool.request()
    .input('UserID', sql.Int, userId)
    .query(`SELECT TOP 1 FullName, Phone FROM dbo.Users WHERE UserID=@UserID`);
  const fullName = u.recordset[0]?.FullName || '';
  const phone    = u.recordset[0]?.Phone || null;

  const ins = await pool.request()
    .input('UserID',   sql.Int, userId)
    .input('FullName', sql.NVarChar(255), fullName)
    .input('Phone',    sql.NVarChar(50),  phone)
    .query(`
      INSERT INTO dbo.Customers (UserID, FullName, Phone, CreatedAt)
      OUTPUT INSERTED.CustomerID AS CustomerID
      VALUES (@UserID, @FullName, @Phone, SYSDATETIME())
    `);
  return ins.recordset[0].CustomerID;
}

/* ---------------- helpers: map trạng thái ---------------- */

// Map Orders.Status (UPPERCASE EN) -> trạng thái tiếng Việt dùng trong lịch sử/DB
const toHistoryVN = (statusUpper) => {
  switch (String(statusUpper || '').toUpperCase()) {
    case 'PENDING':     return 'Chờ xử lý';
    case 'PROCESSING':  return 'Đang xử lý';
    case 'SHIPPED':     return 'Đang giao';
    case 'COMPLETED':   return 'Đã giao';
    case 'CANCELLED':   return 'Đã hủy';
    default:            return 'Chờ xử lý';
  }
};

const enToVn = {
  PENDING:    'Chờ xử lý',
  PROCESSING: 'Đang xử lý',
  SHIPPED:    'Đang giao',
  COMPLETED:  'Đã giao',
  CANCELLED:  'Đã hủy',
};

const normalizeStatusEN = (s) => {
  const u = String(s || '').toUpperCase().trim();
  if (enToVn[u]) return u;
  const t = u.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (t.includes('CHO XU LY')) return 'PENDING';
  if (t.includes('DANG XU LY')) return 'PROCESSING';
  if (t.includes('DANG GIAO'))  return 'SHIPPED';
  if (t.includes('DA GIAO'))    return 'COMPLETED';
  if (t.includes('DA HUY') || t.includes('HUY')) return 'CANCELLED';
  return '';
};

/* ---------- GET /api/orders/my ---------- */
exports.getMyOrders = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize || '10', 10)));
  const offset = (page - 1) * pageSize;

  try {
    const pool = await getPool();
    // 👇 map Users -> Customers
    const customerId = await ensureCustomerForUser(pool, userId);

    const ordersRs = await (new sql.Request(pool))
      .input('CustomerID', sql.Int, customerId)
      .input('Limit', sql.Int, pageSize)
      .input('Offset', sql.Int, offset)
      .query(`
        SELECT 
          o.OrderID, o.CustomerID, o.AddressID, o.Total, o.Status,
          oa.Method AS PaymentMethod, oa.Status AS PaymentStatus,
          o.Note, o.CreatedAt
        FROM dbo.Orders o
        OUTER APPLY (
          SELECT TOP 1 Method, Status
          FROM dbo.Payments p
          WHERE p.OrderID = o.OrderID
          ORDER BY p.PaymentID DESC
        ) oa
        WHERE o.CustomerID = @CustomerID
        ORDER BY o.CreatedAt DESC
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;

        SELECT COUNT(*) AS TotalRows 
        FROM dbo.Orders 
        WHERE CustomerID = @CustomerID;
      `);

    const orders = ordersRs.recordsets[0] || [];
    const totalRows = ordersRs.recordsets[1]?.[0]?.TotalRows || 0;

    if (!orders.length) return res.json({ page, pageSize, totalRows, data: [] });

    const ids = orders.map(o => o.OrderID);
    const reqItems = new sql.Request(pool);
    const placeholders = ids.map((id, idx) => {
      const p = `id${idx}`;
      reqItems.input(p, sql.Int, id);
      return `@${p}`;
    }).join(',');

    const itemsRs = await reqItems.query(`
      SELECT i.OrderID, i.ProductID, i.Quantity, i.UnitPrice, p.Name AS ProductName
      FROM dbo.OrderItems i
      JOIN dbo.Products p ON p.ProductID = i.ProductID
      WHERE i.OrderID IN (${placeholders})
      ORDER BY i.OrderID DESC
    `);

    const byOrder = {};
    for (const it of (itemsRs.recordset || [])) {
      (byOrder[it.OrderID] ||= []).push({
        ProductID: it.ProductID,
        ProductName: it.ProductName,
        Quantity: it.Quantity,
        UnitPrice: Number(it.UnitPrice),
      });
    }

    const data = orders.map(o => ({ ...o, Items: byOrder[o.OrderID] || [] }));
    return res.json({ page, pageSize, totalRows, data });
  } catch (err) {
    console.error('[getMyOrders] ERROR:', err);
    return res.status(500).json({ message: 'Lỗi lấy đơn hàng của tôi', error: err.message });
  }
};

/* ====== Helpers riêng cho CHECKOUT (KHÔNG ảnh hưởng phần khác) ====== */
function toInt(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
// ⬇️ ĐỔI: dùng txOrPool để đọc trong cùng transaction
async function getOptions(txOrPool, productId) {
  const rs = await (new sql.Request(txOrPool))
    .input('pid', sql.Int, productId)
    .query(`
      SELECT 
        OptionID  AS optionId,
        ProductID AS productId,
        ISNULL(Size,'')  AS size,
        ISNULL(Color,'') AS color,
        ISNULL(Stock,0)  AS stock,
        Price
      FROM dbo.ProductOptions
      WHERE ProductID = @pid
      ORDER BY OptionID ASC
    `);
  return rs.recordset || [];
}
function matchVariant(options, colorRaw, sizeRaw) {
  const color = (colorRaw ?? '').toString().trim();
  const size  = (sizeRaw  ?? '').toString().trim();
  if (!color && !size) return { optionId: null, matched: false };
  for (const o of options) {
    const oc = (o.color || '').toString().trim();
    const os = (o.size  || '').toString().trim();
    const colorOk = color ? (oc.toLowerCase() === color.toLowerCase()) : true;
    const sizeOk  = size  ? (os.toLowerCase() === size.toLowerCase())   : true;
    if (colorOk && sizeOk) return { optionId: o.optionId, matched: true };
  }
  return { optionId: null, matched: false };
}
function variantHints(options) {
  return options.map(o => ({
    optionId: o.optionId,
    color: o.color,
    size: o.size,
    stock: o.stock ?? 0,
  }));
}

function buildGuidance({ orderId, amount, method }) {
  const amt = Number(amount || 0);
  const vnd = new Intl.NumberFormat('vi-VN').format(amt);

  switch (String(method || '').toUpperCase()) {
    case 'MOMO':
      return {
        sampleCode: `MM${orderId}`,                    // “mã mẫu MoMo”
        amount: amt,
        note: `Nhập nội dung chuyển tiền: MM${orderId}`,
        // tuỳ chọn nếu bạn có deeplink/QR:
        // deeplink: `momo://...`,
        // qrPayload: '...'
      };
    case 'ATM': // = chuyển khoản ngân hàng
      return {
        bankCode: process.env.BANK_CODE || 'VCB',
        accountNo: process.env.BANK_ACCNO || '0123456789',
        accountName: process.env.BANK_ACCNAME || 'CONG TY ABC',
        amount: amt,
        transferContent: `DH${orderId}`,
        // Có thể host ảnh VietQR tĩnh nếu muốn
        vietqrUrl: `${process.env.PUBLIC_BASE_URL || ''}/static/vietqr/${orderId}.png`
      };
    case 'CARD': // thẻ Visa/Master
      return {
        fields: ['cardNumber', 'expiry', 'cvv'],
        amount: amt,
        note: `Nhập thông tin thẻ để tạo yêu cầu, sau đó xác nhận bằng OTP email`
      };
    case 'COD':
    default:
      return {
        amount: amt,
        note: `Xác nhận OTP để chốt đơn COD #${orderId}`
      };
  }
}

/* ---------- POST /api/orders/checkout ---------- */
exports.checkout = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const { addressId, address, paymentMethod, note, items } = req.body || {};

  const inlineAddress = (!address || typeof address !== 'object') ? {
    fullName: (req.body?.fullName ?? '').toString(),
    phone:    (req.body?.phone ?? '').toString(),
    line1:    (req.body?.line1 ?? req.body?.street ?? req.body?.address1 ?? '').toString(),
    ward:     (req.body?.ward ?? '').toString(),
    district: (req.body?.district ?? req.body?.quan ?? '').toString(),
    city:     (req.body?.city ?? '').toString(),
    province: (req.body?.province ?? req.body?.tinh ?? '').toString(),
  } : null;

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ message: 'Giỏ hàng trống hoặc sai định dạng items' });
  }
  if (!paymentMethod) {
    return res.status(400).json({ message: 'Thiếu phương thức thanh toán' });
  }

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // 👇 map Users -> Customers
    const customerId = await ensureCustomerForUser(pool, userId);

    // 1) resolve addressId
    let finalAddressId = Number(addressId);
    if (!Number.isInteger(finalAddressId) || finalAddressId <= 0) {
      const adr = address && typeof address === 'object' ? address : inlineAddress;

      const fullName = adr?.fullName?.toString().trim();
      const phone    = adr?.phone?.toString().trim();
      const line1    = (adr?.line1 ?? adr?.street ?? adr?.address1 ?? '').toString().trim();
      const ward     = (adr?.ward ?? '').toString().trim() || null;
      const district = (adr?.district ?? adr?.quan ?? '').toString().trim() || null;
      const city     = (adr?.city ?? '').toString().trim() || null;
      const province = (adr?.province ?? adr?.tinh ?? null);

      if (fullName && phone && line1 && (city || province)) {
        const rqInsAdr = new sql.Request(tx);
        rqInsAdr
          .input('UserID',   sql.Int, userId)
          .input('FullName', sql.NVarChar(100), fullName)
          .input('Phone',    sql.VarChar(20),   phone)
          .input('Line1',    sql.NVarChar(255), line1)
          .input('City',     sql.NVarChar(100), city)
          .input('District', sql.NVarChar(100), district)
          .input('Ward',     sql.NVarChar(100), ward)
          .input('Province', sql.NVarChar(100), province);

        const ar = await rqInsAdr.query(`
          INSERT INTO dbo.Addresses (UserID, FullName, Phone, Line1, City, District, Ward, Province, IsDefault)
          OUTPUT INSERTED.AddressID AS id
          VALUES (@UserID, @FullName, @Phone, @Line1, @City, @District, @Ward, @Province, 0);
        `);
        finalAddressId = ar.recordset[0].id;
      } else {
        const def = await (new sql.Request(tx))
          .input('UserID', sql.Int, userId)
          .query(`
            SELECT TOP 1 AddressID
            FROM dbo.Addresses
            WHERE UserID = @UserID
            ORDER BY IsDefault DESC, AddressID DESC
          `);
        if (!def.recordset[0]) {
          await tx.rollback();
          return res.status(400).json({ message: 'Bạn chưa có địa chỉ giao hàng' });
        }
        finalAddressId = def.recordset[0].AddressID;
      }
    } else {
      const adr = await (new sql.Request(tx))
        .input('AdrID', sql.Int, finalAddressId)
        .input('UserID', sql.Int, userId)
        .query(`SELECT 1 FROM dbo.Addresses WHERE AddressID = @AdrID AND UserID = @UserID`);
      if (!adr.recordset.length) {
        await tx.rollback();
        return res.status(400).json({ message: 'Địa chỉ không hợp lệ' });
      }
    }

    // 2) Chuẩn hoá items (tự tìm optionId nếu chỉ có color/size; auto-pick nếu chỉ có 1 option)
    const normalized = [];
    const productNames = []; // ⬅️ gom tên sản phẩm để ghép thông báo
    for (const raw of items) {
      const productId = toInt(raw.productId ?? raw.ProductID ?? raw.id);
      const quantity  = Math.max(1, toInt(raw.quantity ?? raw.qty ?? raw.Qty, 1));
      let   optionId  = toInt(raw.optionId ?? raw.OptionID ?? raw.optionID ?? 0, 0) || null;
      const color     = raw.color ?? raw.Color ?? null;
      const size      = raw.size  ?? raw.Size  ?? null;

      if (!productId || quantity <= 0) {
        await tx.rollback();
        return res.status(400).json({ message:'Item không hợp lệ' });
      }

      const prod = await (new sql.Request(tx))
        .input('pid', sql.Int, productId)
        .query(`SELECT ProductID, Name, Price, ISNULL(Stock,0) AS Stock FROM dbo.Products WHERE ProductID=@pid`);
      const p = prod.recordset?.[0];
      if (!p) {
        await tx.rollback();
        return res.status(400).json({ message:`Sản phẩm ${productId} không tồn tại` });
      }
      productNames.push(p.Name);

      // ⬇️ ĐỌC options trong cùng transaction
      const opts = await getOptions(tx, productId);

      if (!opts.length) {
        // ✅ Sản phẩm KHÔNG có biến thể → kiểm kho ở dbo.Products (LOCK)
        const ps = await (new sql.Request(tx))
          .input('pid', sql.Int, p.ProductID)
          .query(`
            SELECT ISNULL(Stock,0) AS Stock
            FROM dbo.Products WITH (UPDLOCK, ROWLOCK)
            WHERE ProductID=@pid
          `);
        const prodStock = ps.recordset?.[0]?.Stock ?? 0;
        if (prodStock < quantity) {
          await tx.rollback();
          return res.status(409).json({ message: `"${p.Name}" không đủ tồn kho` });
        }

        normalized.push({
          productId: p.ProductID,
          optionId: null,
          quantity,
          unitPrice: Number(p.Price),
          productName: p.Name, // ⬅️ thêm để thông báo
        });
        continue;
      }

      // Có biến thể
      if (!optionId) {
        const { optionId: matchedId, matched } = matchVariant(opts, color, size);
        if (matched && matchedId) optionId = matchedId;
        else if (opts.length === 1) optionId = opts[0].optionId;
      }

      if (!optionId) {
        await tx.rollback();
        return res.status(400).json({
          message: `"${p.Name}" yêu cầu chọn Màu/Size`,
          productId: p.ProductID,
          hints: variantHints(opts),
        });
      }

      const opt = opts.find(o => o.optionId === optionId);
      const unitPrice = opt?.Price != null ? Number(opt.Price) : Number(p.Price);

      // ✅ Kiểm kho biến thể ở Inventory (LOCK)
      const st = await (new sql.Request(tx)).input('oid', sql.Int, optionId)
        .query(`
          SELECT ISNULL(Stock,0) AS Stock 
          FROM dbo.Inventory WITH (UPDLOCK, ROWLOCK) 
          WHERE OptionID=@oid
        `);
      const stock = st.recordset?.[0]?.Stock ?? 0;
      if (stock < quantity) {
        await tx.rollback();
        return res.status(409).json({ message:`"${p.Name}" không đủ tồn kho biến thể đã chọn` });
      }

      normalized.push({
        productId: p.ProductID,
        optionId,
        quantity,
        unitPrice,
        productName: p.Name, // ⬅️ thêm để thông báo
      });
    }

    // 3) Tính tổng
    const grandTotal = normalized.reduce((s, x) => s + (Number(x.unitPrice) * x.quantity), 0);

    // 4) Tạo ORDER trước
    const methodRaw = String(paymentMethod || 'COD').toUpperCase();
    const mapMethod = {
      'COD': 'COD',
      'CASH': 'COD',
      'MOMO': 'MOMO',
      'BANK': 'ATM',
      'ATM': 'ATM',
      'CARD': 'CARD',
      'VISA': 'CARD',
      'MASTERCARD': 'CARD',
      'VISA/MASTERCARD': 'CARD',
    };
    const payMethod = mapMethod[methodRaw] || 'COD';

    const insOrder = await (new sql.Request(tx))
      .input('CustomerID', sql.Int, customerId)
      .input('AddressID',  sql.Int, finalAddressId)
      .input('Total',      sql.Decimal(18, 2), Number(grandTotal.toFixed(2)))
      .input('Status',     sql.NVarChar(50), enToVn.PENDING)  // 'Chờ xử lý'
      .input('Note',       sql.NVarChar(sql.MAX), note ?? null)
      .query(`
        INSERT INTO dbo.Orders (CustomerID, AddressID, Total, Status, Note, CreatedAt)
        VALUES (@CustomerID, @AddressID, @Total, @Status, @Note, GETDATE());

        SELECT SCOPE_IDENTITY() AS OrderID;
      `);

    const orderId = insOrder.recordset?.[0]?.OrderID;

    if (!orderId) { await tx.rollback(); return res.status(500).json({ message: 'Không thể tạo đơn hàng' }); }

    // 5) Insert OrderItems + trừ tồn (biến thể -> Inventory, không biến thể -> Products)
    for (const it of normalized) {
      await (new sql.Request(tx))
        .input('OrderID',  sql.Int, orderId)
        .input('ProductID',sql.Int, it.productId)
        .input('OptionID', sql.Int, it.optionId)
        .input('Quantity', sql.Int, it.quantity)
        .input('UnitPrice',sql.Decimal(18,2), Number(it.unitPrice.toFixed(2)))
        .query(`
          INSERT INTO dbo.OrderItems (OrderID, ProductID, OptionID, Quantity, UnitPrice)
          VALUES (@OrderID, @ProductID, @OptionID, @Quantity, @UnitPrice);

          IF @OptionID IS NOT NULL
          BEGIN
            UPDATE dbo.Inventory
            SET Stock = ISNULL(Stock,0) - @Quantity
            WHERE OptionID = @OptionID;
          END
          ELSE
          BEGIN
            UPDATE dbo.Products WITH (ROWLOCK)
            SET Stock = ISNULL(Stock,0) - @Quantity,
                UpdatedAt = GETDATE()
            WHERE ProductID = @ProductID;
          END
        `);
    }

    // 6) Ghi Payment — PENDING nếu cần OTP, PAID nếu COD
    await (new sql.Request(tx))
  .input('OrderID', sql.Int, orderId)
  .input('Method',  sql.NVarChar(50), payMethod)
  .input('Amount',  sql.Decimal(18, 2), Number(grandTotal.toFixed(2)))
  .input('Status',  sql.NVarChar(50), 'PENDING') // TẤT CẢ → PENDING
  .query(`
    INSERT INTO dbo.Payments (OrderID, Method, Amount, Status)
    VALUES (@OrderID, @Method, @Amount, @Status)
  `);
;

    await tx.commit();

    // 👇 Flag để FE điều hướng & không báo "thành công" ngay khi cần OTP
   const requiresOtp = (payMethod !== 'COD');


    // ========== THÔNG BÁO cho đúng user ==========
    const namesText = pickSomeNames(productNames, 3);
    await notifyUser(req, {
      userId,
      type: 'ORDER_PLACED',
      title: `Đặt hàng thành công`,
      message: `Đơn #${orderId}${namesText ? ` gồm: ${namesText}` : ''}. Tổng ${Number(grandTotal).toLocaleString('vi-VN')}₫`,
      data: { orderId, total: Number(grandTotal), method: payMethod }
    });
    
    // ==============================================

    return res.status(201).json({
  message: 'Đã tạo đơn hàng, vui lòng xác thực thanh toán (OTP).',
  orderId,
  requiresOtp: true,
  amount: Number(grandTotal),
  method: payMethod,
  guidance: buildGuidance({ orderId, amount: grandTotal, method: payMethod }),
  order: {
    OrderID: orderId,
    CustomerID: customerId,
    AddressID: finalAddressId,
    Total: Number(grandTotal.toFixed(2)),
    Status: 'PENDING',
    PaymentMethod: payMethod,
    PaymentStatus: 'PENDING',
    Note: note || null,
    Items: normalized,
  },
});

  } catch (err) {
    try { await tx.rollback(); } catch (_) {}
    console.error('[checkout] ERROR:', err);
    return res.status(500).json({ message: 'Lỗi checkout', error: err.message });
  }
};

exports.getAllOrders = async (req, res) => {
  try {
    const raw = req.query?.status ?? '';
    const statusEN = normalizeStatusEN(raw);
    const statusVN = statusEN ? enToVn[statusEN] : null;

    const pool = await getPool();
    const rs = await pool.request()
      .input('StatusVN', sql.NVarChar(50), statusVN)
      .query(`
        SELECT 
          o.OrderID, o.CustomerID, u.FullName AS CustomerName,
          CASE o.Status
            WHEN N'Chờ xử lý'  THEN 'PENDING'
            WHEN N'Đang xử lý' THEN 'PROCESSING'
            WHEN N'Đang giao'  THEN 'SHIPPED'
            WHEN N'Đã giao'    THEN 'COMPLETED'
            WHEN N'Đã hủy'     THEN 'CANCELLED'
            ELSE 'PENDING'
          END AS Status,
          o.Status AS StatusVN,
          o.Total,
          o.AssignedShipperID, o.AssignedAt,
          oa.Method AS PaymentMethod, oa.Status AS PaymentStatus,
          o.Note, o.CreatedAt, o.UpdatedAt
        FROM dbo.Orders o
        LEFT JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
        LEFT JOIN dbo.Users u     ON u.UserID     = c.UserID
        OUTER APPLY (
          SELECT TOP 1 Method, Status
          FROM dbo.Payments p
          WHERE p.OrderID = o.OrderID
          ORDER BY p.PaymentID DESC
        ) oa
        WHERE (@StatusVN IS NULL OR o.Status = @StatusVN)
        ORDER BY o.CreatedAt DESC
      `);

    return res.json(rs.recordset || []);
  } catch (err) {
    console.error('[getAllOrders] ERROR:', err);
    return res.status(500).json({ message: 'Lỗi lấy danh sách đơn hàng', error: err.message });
  }
};

/* ---------- GET /api/orders/:id (admin) ---------- */
exports.getOrderById = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Thiếu/ID không hợp lệ' });

  try {
    const pool = await getPool();
    const rs = await (new sql.Request(pool))
      .input('OrderID', sql.Int, id)
      .query(`
        SELECT 
          o.OrderID, o.CustomerID, u.FullName AS CustomerName,
          o.Total, o.Status,
          o.AssignedShipperID, o.AssignedAt,
          oa.Method AS PaymentMethod, oa.Status AS PaymentStatus,
          o.Note, o.CreatedAt
        FROM dbo.Orders o
        LEFT JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
        LEFT JOIN dbo.Users u     ON u.UserID     = c.UserID
        OUTER APPLY (
          SELECT TOP 1 Method, Status
          FROM dbo.Payments p
          WHERE p.OrderID = o.OrderID
          ORDER BY p.PaymentID DESC
        ) oa
        WHERE o.OrderID = @OrderID;

        SELECT i.OrderItemID, i.ProductID, p.Name AS ProductName,
               i.Quantity, i.UnitPrice
        FROM dbo.OrderItems i
        JOIN dbo.Products p ON p.ProductID = i.ProductID
        WHERE i.OrderID = @OrderID
        ORDER BY i.OrderItemID ASC;
      `);

    const infoSet = rs.recordsets?.[0] || [];
    if (!infoSet.length) return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });

    const info = infoSet[0];
    const items = rs.recordsets?.[1] || [];
    return res.json({ ...info, Items: items });
  } catch (err) {
    console.error('[getOrderById] ERROR:', err);
    return res.status(500).json({ message: 'Lỗi lấy chi tiết đơn hàng', error: err.message });
  }
};

/* ---------- PUT/POST /api/orders/:id/status (admin) ---------- */
exports.updateOrderStatus = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Thiếu/ID không hợp lệ' });
  }

  const rawStatus = String(req.body?.status ?? '').trim();
  const mapToDb = {
    pending: 'PENDING',
    confirmed: 'PROCESSING',
    processing: 'PROCESSING',
    shipping: 'SHIPPED',
    shipped: 'SHIPPED',
    delivered: 'COMPLETED',
    completed: 'COMPLETED',
    cancelled: 'CANCELLED',
    canceled: 'CANCELLED',
  };
  const normalized = mapToDb[rawStatus.toLowerCase()] || rawStatus.toUpperCase();
  const allowed = ['PENDING', 'PROCESSING', 'SHIPPED', 'COMPLETED', 'CANCELLED'];
  if (!allowed.includes(normalized)) {
    return res.status(400).json({ message: 'Trạng thái không hợp lệ', normalized, allowed });
  }

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // Lấy status hiện tại (VN) kèm lock + user nhận thông báo
    const cur = await (new sql.Request(tx))
      .input('OrderID', sql.Int, id)
      .query(`
        SELECT o.Status, u.UserID
        FROM dbo.Orders o WITH (UPDLOCK, ROWLOCK)
        JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
        JOIN dbo.Users     u ON u.UserID     = c.UserID
        WHERE o.OrderID = @OrderID
      `);
    if (!cur.recordset[0]) {
      await tx.rollback();
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
    }

    const oldStatusVN = cur.recordset[0].Status;                // ví dụ: 'Đã giao'
    const newStatusVN = enToVn[normalized] || 'Chờ xử lý';
    const ownerUserId = cur.recordset[0].UserID;

    // Cập nhật trạng thái
    const updRs = await (new sql.Request(tx))
      .input('OrderID', sql.Int, id)
      .input('Status', sql.NVarChar(50), newStatusVN)
      .query(`
        DECLARE @tmp TABLE (OrderID INT, Status NVARCHAR(50));
        UPDATE dbo.Orders
        SET Status = @Status,
            UpdatedAt = GETDATE()
        OUTPUT INSERTED.OrderID, INSERTED.Status INTO @tmp
        WHERE OrderID = @OrderID;

        SELECT OrderID, Status FROM @tmp;
      `);

    const row = updRs.recordset?.[0];
    if (!row) {
      await tx.rollback();
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
    }

    // Ghi lịch sử
    await (new sql.Request(tx))
      .input('OrderID', sql.Int, id)
      .input('OldStatus', sql.NVarChar(50), oldStatusVN)
      .input('NewStatus', sql.NVarChar(50), newStatusVN)
      .input('ChangedBy', sql.Int, req.user?.id ?? null)
      .input('Note', sql.NVarChar(sql.MAX), req.body?.note || null)
      .query(`
        INSERT INTO dbo.OrderStatusHistory (OrderID, OldStatus, NewStatus, ChangedAt, ChangedBy, Note)
        VALUES (@OrderID, @OldStatus, @NewStatus, GETDATE(), @ChangedBy, @Note)
      `);

    await tx.commit();

    // ====== THÔNG BÁO theo trạng thái ======
    if (normalized === 'SHIPPED') {
      await notifyUser(req, {
        userId: ownerUserId,
        type: 'ORDER_SHIPPED',
        title: `Đơn #${id} đang được giao`,
        message: `Đơn hàng của bạn đang trên đường vận chuyển.`,
        data: { orderId: id }
      });
    } else if (normalized === 'COMPLETED') {
      await notifyUser(req, {
        userId: ownerUserId,
        type: 'ORDER_DELIVERED',
        title: `Đơn #${id} đã giao`,
        message: `Cảm ơn bạn đã mua sắm!`,
        data: { orderId: id }
      });
    }
    // =======================================

    return res.json({ message: 'Cập nhật trạng thái thành công', order: row });
  } catch (err) {
    try { await tx.rollback(); } catch {}
    console.error('[updateOrderStatus] ERROR:', err);
    return res.status(500).json({ message: 'Lỗi cập nhật trạng thái', error: err.message });
  }
};


// controllers/orderController.js  — getOrderItemsSimple (REWRITE)
exports.getOrderItemsSimple = async (req, res) => {
  // Cho phép nhận orderId ở :orderId | :id | ?orderId= | body.orderId
  const raw =
    req.params?.orderId ??
    req.params?.id ??
    req.query?.orderId ??
    req.body?.orderId;
  const orderId = Number(raw);

  const me = req.user || {};
  const userId =
    me.id ?? me.userId ?? me.UserID ?? me.userID ?? null;
  const role = String(me.role || me.Role || '').toLowerCase();
  const isAdmin = role === 'admin';

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return res.status(400).json({ message: 'orderId invalid' });
  }
  if (!isAdmin && !userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const pool = await getPool();

    // Lấy (hoặc tạo) CustomerID cho user khi không phải admin
    let customerId = null;
    if (!isAdmin) {
      customerId = await ensureCustomerForUser(pool, userId);
      if (!customerId) {
        return res.status(403).json({ message: 'Không xác định được khách hàng' });
      }
    }

    // Nếu không phải admin, xác nhận quyền truy cập đơn (đỡ trả rỗng gây khó hiểu)
    if (!isAdmin) {
      const own = await pool.request()
        .input('OrderID', sql.Int, orderId)
        .input('CustomerID', sql.Int, customerId)
        .query(`
          SELECT 1
          FROM dbo.Orders
          WHERE OrderID=@OrderID AND CustomerID=@CustomerID
        `);
      if (!own.recordset.length) {
        return res.status(403).json({ message: 'Không có quyền xem items của đơn này' });
      }
    }

    // Main query:
    //  - JOIN Products để lấy tên
    //  - LEFT JOIN ProductImages (ảnh chính)
    //  - LEFT JOIN ProductOptions để lấy biến thể (màu/size) nếu có
    //  - Reviewed: đã có review cho OrderItem đó (với customer hiện tại nếu là user)
    const sqlText = isAdmin
      ? `
        SELECT 
          oi.OrderItemID,
          oi.OrderID,
          oi.ProductID,
          p.Name                           AS ProductName,
          oi.Quantity,
          oi.UnitPrice,
          CAST(oi.Quantity * oi.UnitPrice AS DECIMAL(18,2)) AS LineTotal,
          oi.OptionID,
          po.Color,
          po.Size,
          pi.Url                           AS ImageUrl,
          CASE WHEN EXISTS (
            SELECT 1 FROM dbo.Reviews r
            WHERE r.OrderItemID = oi.OrderItemID
          ) THEN 1 ELSE 0 END               AS Reviewed
        FROM dbo.OrderItems oi
        JOIN dbo.Orders     o  ON o.OrderID    = oi.OrderID
        JOIN dbo.Products   p  ON p.ProductID  = oi.ProductID
        LEFT JOIN dbo.ProductOptions po ON po.OptionID  = oi.OptionID
        LEFT JOIN dbo.ProductImages  pi ON pi.ProductID = p.ProductID AND ISNULL(pi.IsMain,0)=1
        WHERE oi.OrderID = @OrderID
        ORDER BY oi.OrderItemID ASC
      `
      : `
        SELECT 
          oi.OrderItemID,
          oi.OrderID,
          oi.ProductID,
          p.Name                           AS ProductName,
          oi.Quantity,
          oi.UnitPrice,
          CAST(oi.Quantity * oi.UnitPrice AS DECIMAL(18,2)) AS LineTotal,
          oi.OptionID,
          po.Color,
          po.Size,
          pi.Url                           AS ImageUrl,
          CASE WHEN EXISTS (
            SELECT 1 FROM dbo.Reviews r
            WHERE r.OrderItemID = oi.OrderItemID
              AND r.CustomerID  = @CustomerID
          ) THEN 1 ELSE 0 END               AS Reviewed
        FROM dbo.OrderItems oi
        JOIN dbo.Orders     o  ON o.OrderID    = oi.OrderID
        JOIN dbo.Products   p  ON p.ProductID  = oi.ProductID
        LEFT JOIN dbo.ProductOptions po ON po.OptionID  = oi.OptionID
        LEFT JOIN dbo.ProductImages  pi ON pi.ProductID = p.ProductID AND ISNULL(pi.IsMain,0)=1
        WHERE oi.OrderID = @OrderID
          AND o.CustomerID = @CustomerID
        ORDER BY oi.OrderItemID ASC
      `;

    const r = await pool.request()
      .input('OrderID', sql.Int, orderId)
      .input('CustomerID', sql.Int, customerId ?? 0)
      .query(sqlText);

    // Chuẩn hóa kết quả (nếu cần thêm URL tuyệt đối thì map ở đây)
    const items = (r.recordset || []).map(x => ({
      OrderItemID : x.OrderItemID,
      OrderID     : x.OrderID,
      ProductID   : x.ProductID,
      ProductName : x.ProductName,
      Quantity    : Number(x.Quantity) || 0,
      UnitPrice   : Number(x.UnitPrice) || 0,
      LineTotal   : Number(x.LineTotal) || 0,
      OptionID    : x.OptionID ?? null,
      Color       : x.Color ?? null,
      Size        : x.Size ?? null,
      ImageUrl    : x.ImageUrl || null,
      Reviewed    : x.Reviewed ? 1 : 0,
    }));

    return res.json({ items });
  } catch (e) {
    console.error('[getOrderItemsSimple] ERROR:', e);
    return res.status(500).json({ message: 'Lỗi lấy OrderItems', error: String(e) });
  }
};


/* ---------- DELETE /api/orders/:id (admin) ---------- */
exports.deleteOrder = async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ message: 'Thiếu/ID không hợp lệ' });

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    const exists = await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .query(`SELECT 1 FROM dbo.Orders WHERE OrderID = @OrderID`);
    if (!exists.recordset.length) {
      await tx.rollback();
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
    }

    // ⬇️ ĐỔI: lấy cả OptionID để hoàn kho đúng bảng
    const itemsRs = await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .query(`
        SELECT ProductID, OptionID, Quantity 
        FROM dbo.OrderItems 
        WHERE OrderID = @OrderID
      `);

    for (const it of (itemsRs.recordset || [])) {
      if (it.OptionID) {
        // Hoàn kho biến thể về Inventory
        await (new sql.Request(tx))
          .input('OptionID', sql.Int, it.OptionID)
          .input('Qty', sql.Int, it.Quantity)
          .query(`
            UPDATE dbo.Inventory 
            SET Stock = ISNULL(Stock,0) + @Qty 
            WHERE OptionID = @OptionID
          `);
      } else {
        // Sản phẩm không biến thể → hoàn về Products.Stock (nếu có dùng cột này)
        await (new sql.Request(tx))
          .input('ProductID', sql.Int, it.ProductID)
          .input('Qty', sql.Int, it.Quantity)
          .query(`
            UPDATE dbo.Products 
            SET Stock = ISNULL(Stock,0) + @Qty 
            WHERE ProductID = @ProductID
          `);
      }
    }

    await (new sql.Request(tx)).input('OrderID', sql.Int, orderId).query(`DELETE FROM dbo.Payments WHERE OrderID = @OrderID`);
    await (new sql.Request(tx)).input('OrderID', sql.Int, orderId).query(`DELETE FROM dbo.OrderItems WHERE OrderID = @OrderID`);
    await (new sql.Request(tx)).input('OrderID', sql.Int, orderId).query(`DELETE FROM dbo.Orders WHERE OrderID = @OrderID`);

    await tx.commit();
    return res.json({ message: 'Xóa đơn hàng thành công', orderId });
  } catch (err) {
    try { await tx.rollback(); } catch (_) {}
    console.error('[deleteOrder] ERROR:', err);
    return res.status(500).json({ message: 'Lỗi xóa đơn hàng', error: err.message });
  }
};

/* ----------------------------------------------------------------
   BỔ SUNG: GÁN / HUỶ GÁN SHIPPER (+ đổi trạng thái & ghi lịch sử VN)
   ---------------------------------------------------------------- */

/* ---------- POST /api/orders/:id/assign-shipper ---------- */
exports.assignShipper = async (req, res) => {
  const orderId = Number(req.params.id);
  const shipperId = Number(req.body?.shipperId);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ message: 'ID đơn không hợp lệ' });
  if (!Number.isInteger(shipperId) || shipperId <= 0) return res.status(400).json({ message: 'shipperId không hợp lệ' });

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    const cur = await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .query(`SELECT Status FROM dbo.Orders WITH (UPDLOCK, ROWLOCK) WHERE OrderID = @OrderID`);
    if (!cur.recordset[0]) {
      await tx.rollback();
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
    }
    const oldStatusVN = cur.recordset[0].Status;
    const oldStatusEN = normalizeStatusEN(oldStatusVN);
    if (['CANCELLED', 'COMPLETED'].includes(oldStatusEN)) {
      await tx.rollback();
      return res.status(400).json({ message: 'Đơn không thể gán shipper ở trạng thái hiện tại' });
    }
    const newStatusEN = (oldStatusEN === 'PENDING') ? 'PROCESSING' : oldStatusEN;
    const newStatusVN = enToVn[newStatusEN];

    const sp = await (new sql.Request(tx))
      .input('ShipperID', sql.Int, shipperId)
      .query(`SELECT 1 FROM dbo.Shippers WHERE ShipperID = @ShipperID`);
    if (!sp.recordset.length) {
      await tx.rollback();
      return res.status(400).json({ message: 'Shipper không tồn tại' });
    }

    await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .input('ShipperID', sql.Int, shipperId)
      .input('NewStatus', sql.NVarChar, newStatusVN)
      .query(`
        UPDATE dbo.Orders
        SET AssignedShipperID = @ShipperID,
            AssignedAt        = GETDATE(),
            Status            = @NewStatus,
            UpdatedAt         = GETDATE()
        WHERE OrderID = @OrderID
      `);

    await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .input('OldStatus', sql.NVarChar, oldStatusVN)
      .input('NewStatus', sql.NVarChar, newStatusVN)
      .input('ChangedBy', sql.Int, req.user?.id ?? null)
      .input('Note', sql.NVarChar, req.body?.note || 'Gán shipper')
      .query(`
        INSERT INTO dbo.OrderStatusHistory(OrderID, OldStatus, NewStatus, ChangedAt, ChangedBy, Note)
        VALUES (@OrderID, @OldStatus, @NewStatus, GETDATE(), @ChangedBy, @Note)
      `);

    await tx.commit();
    return res.json({ message: 'Đã gán shipper', orderId, newStatus: newStatusEN });
  } catch (err) {
    try { await tx.rollback(); } catch (_) {}
    console.error('[assignShipper] ERROR:', err);
    return res.status(500).json({ message: 'Gán shipper thất bại', error: err.message });
  }
};

// ---------- GET /api/orders/:id/summary ----------
exports.getOrderSummary = async (req, res) => {
  try {
    const orderId = parseInt(req.params.id || req.params.orderId, 10);
    if (!orderId) return res.status(400).json({ message: 'Invalid order id' });

    const me = req.user || {};
    const userId = me.id ?? me.userId ?? me.UserID ?? null;
    const role = (me.role || me.Role || '').toString().toLowerCase();
    const isAdmin = role === 'admin';

    const pool = await getPool();

    const rq = pool.request()
      .input('OrderID', sql.Int, orderId);

    let whereCustomer = '';
    if (!isAdmin && userId) {
      const customerId = await ensureCustomerForUser(pool, userId);
      rq.input('CustomerID', sql.Int, customerId);
      whereCustomer = 'AND o.CustomerID = @CustomerID';
    }

    const info = await rq.query(`
      SELECT 
        o.OrderID,
        o.CustomerID,
        o.AddressID,
        o.Total AS TotalAmount,
        o.Status,
        a.FullName, a.Phone, a.Line1, a.Ward, a.District, a.City, a.Province,
        pa.Method AS PaymentMethod,
        pa.Status AS PaymentStatus,
        pa.Amount AS PaymentAmount
      FROM dbo.Orders o
      LEFT JOIN dbo.Addresses a ON a.AddressID = o.AddressID
      OUTER APPLY (
        SELECT TOP 1 Method, Status, Amount
        FROM dbo.Payments p
        WHERE p.OrderID = o.OrderID
        ORDER BY p.PaymentID DESC
      ) pa
      WHERE o.OrderID = @OrderID
      ${whereCustomer}
    `);

    if (!info.recordset.length) {
      return res.status(404).json({ message: 'Order not found' });
    }
    const ord = info.recordset[0];

    const its = await pool.request()
      .input('OrderID', sql.Int, orderId)
      .query(`
        SELECT 
          i.OrderItemID,
          i.ProductID,
          p.Name AS name,
          i.Quantity AS qty,
          i.UnitPrice AS price,
          i.OptionID
        FROM dbo.OrderItems i
        JOIN dbo.Products p ON p.ProductID = i.ProductID
        WHERE i.OrderID = @OrderID
        ORDER BY i.OrderItemID ASC
      `);

    const items = its.recordset || [];
    const total = Number(ord.TotalAmount ?? items.reduce((s, r) => s + Number(r.price) * Number(r.qty), 0));

    return res.json({
      orderId,
      status: ord.Status,
      total,
      payment: {
        method: (ord.PaymentMethod || '').toString().toUpperCase(),
        status: ord.PaymentStatus || 'PENDING',
        amount: Number(ord.PaymentAmount ?? total),
      },
      address: {
        fullName: ord.FullName,
        phone: ord.Phone,
        line1: ord.Line1,
        ward: ord.Ward,
        district: ord.District,
        city: ord.City,
        province: ord.Province,
      },
      items,
    });
  } catch (e) {
    console.error('[getOrderSummary] ERROR:', e);
    return res.status(500).json({ message: 'getOrderSummary error', error: String(e) });
  }
};

/* ---------- POST /api/orders/:id/unassign-shipper ---------- */
exports.unassignShipper = async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ message: 'ID đơn không hợp lệ' });

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    const cur = await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .query(`SELECT Status FROM dbo.Orders WITH (UPDLOCK, ROWLOCK) WHERE OrderID = @OrderID`);
    if (!cur.recordset[0]) {
      await tx.rollback();
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
    }
    const oldStatusVN = cur.recordset[0].Status;
    const oldStatusEN = normalizeStatusEN(oldStatusVN);
    if (['SHIPPED', 'COMPLETED'].includes(oldStatusEN)) {
      await tx.rollback();
      return res.status(400).json({ message: 'Không thể huỷ gán ở trạng thái đã giao/hoàn tất' });
    }
    const newStatusEN = (oldStatusEN === 'PROCESSING') ? 'PENDING' : oldStatusEN;
    const newStatusVN = enToVn[newStatusEN];

    await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .input('NewStatus', sql.NVarChar, newStatusVN)
      .query(`
        UPDATE dbo.Orders
        SET AssignedShipperID = NULL,
            AssignedAt        = NULL,
            Status            = @NewStatus,
            UpdatedAt         = GETDATE()
        WHERE OrderID = @OrderID
      `);

    await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .input('OldStatus', sql.NVarChar, oldStatusVN)
      .input('NewStatus', sql.NVarChar, newStatusVN)
      .input('ChangedBy', sql.Int, req.user?.id ?? null)
      .input('Note', sql.NVarChar, req.body?.note || 'Huỷ gán shipper')
      .query(`
        INSERT INTO dbo.OrderStatusHistory(OrderID, OldStatus, NewStatus, ChangedAt, ChangedBy, Note)
        VALUES (@OrderID, @OldStatus, @NewStatus, GETDATE(), @ChangedBy, @Note)
      `);

    await tx.commit();
    return res.json({ message: 'Đã huỷ gán shipper', orderId, newStatus: newStatusEN });
  } catch (err) {
    try { await tx.rollback(); } catch (_) {}
    console.error('[unassignShipper] ERROR:', err);
    return res.status(500).json({ message: 'Huỷ gán thất bại', error: err.message });
  }
};

/* ===================== NEW: GỬI OTP EMAIL ===================== */
// POST /api/orders/:id/send-otp  (owner hoặc admin)
exports.sendOtpEmail = async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ message: 'Thiếu/ID không hợp lệ' });
  }

  const me = req.user || {};
  const userId = me.id ?? me.userId ?? me.UserID ?? null;
  const role = (me.role || me.Role || '').toString().toLowerCase();
  const isAdmin = role === 'admin';

  if (!userId && !isAdmin) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const pool = await getPool();

    // Lấy chủ sở hữu đơn + email nhận OTP
    const info = await pool.request()
      .input('OrderID', sql.Int, orderId)
      .query(`
        SELECT o.OrderID, c.CustomerID, u.UserID, u.Email, u.FullName
        FROM dbo.Orders o
        JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
        JOIN dbo.Users u     ON u.UserID     = c.UserID
        WHERE o.OrderID = @OrderID
      `);
    const row = info.recordset?.[0];
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });

    const isOwner = Number(userId) === Number(row.UserID);
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ message: 'NO_PERMISSION' });
    }

    // Sinh OTP 6 số & hết hạn 10 phút
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expireAt = new Date(Date.now() + 10 * 60 * 1000);

    // Lưu OTP vào Orders
    await pool.request()
      .input('OrderID', sql.Int, orderId)
      .input('OtpCode', sql.NVarChar(10), code)
      .input('OtpExpireAt', sql.DateTime2, expireAt)
      .query(`
        UPDATE dbo.Orders
        SET OtpCode = @OtpCode,
            OtpExpireAt = @OtpExpireAt,
            UpdatedAt = GETDATE()
        WHERE OrderID = @OrderID
      `);

    // Gửi email bằng SMTP (Gmail App Password khuyến nghị)
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const toEmail = row.Email || req.body?.email;
    if (!toEmail) return res.status(400).json({ message: 'Không có email người nhận OTP' });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: toEmail,
      subject: `Mã OTP xác nhận thanh toán cho đơn #${orderId}`,
      text: `Xin chào ${row.FullName || ''},\n\nMã OTP của bạn là: ${code}\nMã sẽ hết hạn sau 10 phút.\n\nXin cảm ơn.`,
      html: `
        <p>Xin chào ${row.FullName || ''},</p>
        <p>Mã OTP của bạn là: <b style="font-size:18px">${code}</b></p>
        <p>Mã sẽ hết hạn sau <b>10 phút</b>.</p>
        <p>Xin cảm ơn.</p>
      `,
    });

    return res.json({ message: 'Đã gửi OTP qua email', orderId, expireAt });
  } catch (err) {
    console.error('[sendOtpEmail] ERROR:', err);
    return res.status(500).json({ message: 'Gửi OTP thất bại', error: err.message });
  }

};
// ======= THÊM VÀO CUỐI FILE controllers/orderController.js =======
exports.cancelMyOrder = async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ message: 'ID đơn không hợp lệ' });
  }

  const me = req.user || {};
  const role = (me.role || me.Role || '').toString().toLowerCase();
  const userId = me.id ?? me.userId ?? me.UserID ?? null;

  if (!userId && role !== 'admin') {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();

    // Lock row + kiểm tra quyền sở hữu nếu là customer
    const rq = new sql.Request(tx);
    const orderRs = await rq
      .input('OrderID', sql.Int, orderId)
      .query(`
        SELECT o.OrderID, o.CustomerID, o.Status, u.UserID
        FROM dbo.Orders o WITH (UPDLOCK, ROWLOCK)
        JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
        JOIN dbo.Users     u ON u.UserID     = c.UserID
        WHERE o.OrderID = @OrderID
      `);

    if (!orderRs.recordset[0]) {
      await tx.rollback();
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
    }

    const ord = orderRs.recordset[0];
    const ownerUserId = ord.UserID;

    if (role !== 'admin') {
      const myCustomerId = await ensureCustomerForUser(pool, userId);
      if (Number(ord.CustomerID) !== Number(myCustomerId)) {
        await tx.rollback();
        return res.status(403).json({ message: 'Bạn không thể hủy đơn của người khác' });
      }
    }

    // Không cho hủy nếu đã giao/đang giao/đã hủy
    const curVN = ord.Status || '';
    const curEN = normalizeStatusEN(curVN);
    if (['SHIPPED', 'COMPLETED', 'CANCELLED'].includes(curEN)) {
      await tx.rollback();
      return res.status(400).json({ message: 'Đơn hàng không thể hủy ở trạng thái hiện tại' });
    }

    // Lấy OrderItems để hoàn kho
    const itemsRs = await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .query(`
        SELECT ProductID, OptionID, Quantity
        FROM dbo.OrderItems
        WHERE OrderID = @OrderID
      `);

    for (const it of (itemsRs.recordset || [])) {
      if (it.OptionID) {
        await (new sql.Request(tx))
          .input('OptionID', sql.Int, it.OptionID)
          .input('Qty', sql.Int, it.Quantity)
          .query(`
            UPDATE dbo.Inventory
            SET Stock = ISNULL(Stock,0) + @Qty
            WHERE OptionID = @OptionID
          `);
      } else {
        await (new sql.Request(tx))
          .input('ProductID', sql.Int, it.ProductID)
          .input('Qty', sql.Int, it.Quantity)
          .query(`
            UPDATE dbo.Products
            SET Stock = ISNULL(Stock,0) + @Qty
            WHERE ProductID = @ProductID
          `);
      }
    }

    const newStatusVN = enToVn['CANCELLED']; // 'Đã hủy'

    // Cập nhật trạng thái đơn + UpdatedAt
    await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .input('Status', sql.NVarChar(50), newStatusVN)
      .query(`
        UPDATE dbo.Orders
        SET Status = @Status,
            UpdatedAt = GETDATE()
        WHERE OrderID = @OrderID
      `);

    // Ghi lịch sử trạng thái
    await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .input('OldStatus', sql.NVarChar(50), curVN)
      .input('NewStatus', sql.NVarChar(50), newStatusVN)
      .input('ChangedBy', sql.Int, userId ?? null)
      .input('Note', sql.NVarChar(sql.MAX), 'Khách hàng hủy đơn')
      .query(`
        INSERT INTO dbo.OrderStatusHistory (OrderID, OldStatus, NewStatus, ChangedAt, ChangedBy, Note)
        VALUES (@OrderID, @OldStatus, @NewStatus, GETDATE(), @ChangedBy, @Note)
      `);

    // Nếu có Payment đang PENDING -> optional: chuyển 'CANCELLED'
    await (new sql.Request(tx))
      .input('OrderID', sql.Int, orderId)
      .query(`
        UPDATE dbo.Payments
        SET Status = CASE WHEN Status <> 'PAID' THEN 'CANCELLED' ELSE Status END
        WHERE OrderID = @OrderID
      `);

    await tx.commit();

    // ===== Thông báo hủy đơn cho đúng user =====
    await notifyUser(req, {
      userId: ownerUserId,
      type: 'ORDER_CANCELLED',
      title: `Đơn #${orderId} đã hủy`,
      message: `Đơn hàng của bạn đã được hủy.`,
      data: { orderId }
    });
    // ===========================================

    return res.json({ message: 'Đã hủy đơn hàng', orderId, status: 'CANCELLED' });
  } catch (err) {
    console.error('[cancelMyOrder] ERROR:', err);
    return res.status(500).json({ message: 'Hủy đơn thất bại', error: err.message });
  }
};
