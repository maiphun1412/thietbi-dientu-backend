// controllers/adminController.js
const { getPool, sql } = require('../config/db');

/* ===================== Meta cache (5 phút) ===================== */
let _metaCache = null;
let _metaCacheAt = 0;
const _META_TTL_MS = 5 * 60 * 1000;

async function loadMeta(pool) {
  const rs = await pool.request().query(`
    SELECT
      OrdersDateCol =
        (SELECT TOP 1 name FROM sys.columns
         WHERE object_id = OBJECT_ID('dbo.Orders')
           AND name IN ('CreatedAt','OrderDate','CreatedDate','DateCreated')
         ORDER BY CASE name WHEN 'CreatedAt' THEN 1 WHEN 'OrderDate' THEN 2
                            WHEN 'CreatedDate' THEN 3 ELSE 4 END),

      OrdersDateColAny =
        (SELECT TOP 1 name FROM sys.columns
         WHERE object_id = OBJECT_ID('dbo.Orders')
           AND system_type_id IN (40,42,43,58,61)
         ORDER BY column_id),

      HasCustomers = CASE WHEN OBJECT_ID('dbo.Customers') IS NOT NULL THEN 1 ELSE 0 END,
      CustomersDateCol =
        (SELECT TOP 1 name FROM sys.columns
         WHERE object_id = OBJECT_ID('dbo.Customers')
           AND name IN ('CreatedAt','RegisterAt','CreatedDate','DateCreated')
         ORDER BY CASE name WHEN 'CreatedAt' THEN 1 WHEN 'RegisterAt' THEN 2
                            WHEN 'CreatedDate' THEN 3 ELSE 4 END),

      OI_QtyCol =
        (SELECT TOP 1 name FROM sys.columns
         WHERE object_id = OBJECT_ID('dbo.OrderItems')
           AND name IN ('Quantity','Qty')
         ORDER BY CASE name WHEN 'Quantity' THEN 1 ELSE 2 END),

      OI_UnitPriceCol =
        (SELECT TOP 1 name FROM sys.columns
         WHERE object_id = OBJECT_ID('dbo.OrderItems')
           AND name IN ('UnitPrice','Price')
         ORDER BY CASE name WHEN 'UnitPrice' THEN 1 ELSE 2 END),

      OrdersTotalCol =
        (SELECT TOP 1 name FROM sys.columns
         WHERE object_id = OBJECT_ID('dbo.Orders')
           AND name IN ('TotalAmount','GrandTotal','Total','Amount')
         ORDER BY CASE name WHEN 'TotalAmount' THEN 1 WHEN 'GrandTotal' THEN 2
                            WHEN 'Total' THEN 3 ELSE 4 END),

      HasProductStock   = CASE WHEN COL_LENGTH('dbo.Products','Stock')    IS NULL THEN 0 ELSE 1 END,
      HasProductActive  = CASE WHEN COL_LENGTH('dbo.Products','IsActive') IS NULL THEN 0 ELSE 1 END,

      HasProductOptions =
        CASE WHEN OBJECT_ID('dbo.ProductOptions') IS NOT NULL
              AND COL_LENGTH('dbo.ProductOptions','Stock') IS NOT NULL
             THEN 1 ELSE 0 END,
      HasProductOptionsFK =
        CASE WHEN COL_LENGTH('dbo.ProductOptions','ProductID') IS NOT NULL
             THEN 1 ELSE 0 END
  `);
  return rs.recordset[0] || {};
}

async function getMeta(pool) {
  const now = Date.now();
  if (_metaCache && now - _metaCacheAt < _META_TTL_MS) return _metaCache;
  _metaCache = await loadMeta(pool);
  _metaCacheAt = now;
  return _metaCache;
}

/* ===================== GET /api/admin/dashboard ===================== */
/**
 * ?granularity=day|month&days=7&months=6&onlyPaid=0|1&lowThreshold=10&includeInactive=0|1
 */
exports.getDashboard = async (req, res) => {
  const granularity = String(req.query.granularity || 'day').toLowerCase(); // 'day' | 'month'
  const days   = Math.min(Math.max(parseInt(req.query.days   || '7', 10), 1), 90);
  const months = Math.min(Math.max(parseInt(req.query.months || '6', 10), 1), 24);
  const onlyPaid = String(req.query.onlyPaid || '0') === '1';

  // cấu hình tồn kho thấp
  const lowThreshold = parseInt(req.query.lowThreshold || req.query.threshold || '10', 10);
  const includeInactive =
    String(req.query.includeInactive || '0') === '1' ||
    String(req.query.includeInactive || 'false').toLowerCase() === 'true';

  try {
    const pool = await getPool();
    const meta = await getMeta(pool);

    // Xác định cột ngày ở Orders (có thể null nếu bảng dị dạng)
    const ordDateCol = meta.OrdersDateCol || meta.OrdersDateColAny || null;

    // Customers: chỉ dùng khi có bảng + cột ngày
    const hasCustomers = meta.HasCustomers === 1 && !!meta.CustomersDateCol;
    const cusDateCol   = hasCustomers ? meta.CustomersDateCol : null;

    // Doanh thu: ưu tiên từ OrderItems (qty*price); nếu không có thì dùng Orders.Total*
    let revenueExpr = 'CAST(0 AS float)';
    let revenueJoin = '';
    if (meta.OI_QtyCol && meta.OI_UnitPriceCol) {
      revenueJoin = 'JOIN dbo.OrderItems oi ON oi.OrderID = o.OrderID';
      revenueExpr = `SUM(TRY_CAST(oi.[${meta.OI_QtyCol}] AS float) * TRY_CAST(oi.[${meta.OI_UnitPriceCol}] AS float))`;
    } else if (meta.OrdersTotalCol) {
      revenueExpr = `SUM(TRY_CAST(o.[${meta.OrdersTotalCol}] AS float))`;
    }

    // Bộ lọc trạng thái
    const statusFilter = onlyPaid
      ? `IN ('Paid','PAID','Processing','PROCESSING','Shipped','SHIPPED','Completed','COMPLETED','Delivered','DELIVERED')`
      : `NOT IN ('Cancel','CANCEL','Cancelled','CANCELLED','Refund','REFUND')`;

    // Trường hợp xấu nhất: không tìm thấy cột ngày ở Orders -> trả default
    if (!ordDateCol) {
      return res.json({
        kpis: {
          revenueToday: 0,
          ordersToday: 0,
          lowStock: 0,
          newCustomers: 0,
          lowThreshold,
          includeInactive
        },
        ordersSeries: { labels: [], values: [], granularity }
      });
    }

    // ===== Low stock (đồng bộ StockScreen): ĐẾM THEO SẢN PHẨM =====
    const lowStockSql =
      meta.HasProductStock
        ? `
          SELECT COUNT(*) AS lowStock
          FROM dbo.Products p
          WHERE ISNULL(p.Stock, 0) <= @lowThreshold
            ${meta.HasProductActive ? 'AND ( @includeInactive = 1 OR ISNULL(p.IsActive,1) = 1 )' : ''};
        `
        : (
          (meta.HasProductOptions === 1 && meta.HasProductOptionsFK === 1)
            ? `
              SELECT COUNT(DISTINCT p.ProductID) AS lowStock
              FROM dbo.Products p
              JOIN dbo.ProductOptions po ON po.ProductID = p.ProductID
              WHERE ISNULL(po.Stock,0) <= @lowThreshold
                ${meta.HasProductActive ? 'AND ( @includeInactive = 1 OR ISNULL(p.IsActive,1) = 1 )' : ''};
            `
            : `SELECT CAST(0 AS int) AS lowStock;`
        );

    // ---------------- Compose SQL an toàn ----------------
    let sqlText = `
      SET NOCOUNT ON;
      DECLARE @today date = CAST(GETDATE() AS date);
    `;

    if (granularity === 'month') {
      sqlText += `
        DECLARE @startOfThisMonth date = DATEFROMPARTS(YEAR(@today), MONTH(@today), 1);
        DECLARE @start date = DATEFROMPARTS(
          YEAR(DATEADD(month, -(@months-1), @today)),
          MONTH(DATEADD(month, -(@months-1), @today)), 1
        );

        /* KPI tháng này */
        ;WITH k AS (
          SELECT Revenue = ${revenueExpr}, Orders = COUNT(DISTINCT o.OrderID)
          FROM dbo.Orders o
          ${revenueJoin}
          WHERE o.Status ${statusFilter}
            AND o.[${ordDateCol}] >= @startOfThisMonth
            AND o.[${ordDateCol}] <  DATEADD(month, 1, @startOfThisMonth)
        )
        SELECT ISNULL(Revenue,0) AS revenueToday, ISNULL(Orders,0) AS ordersToday
        FROM k;

        /* Low stock */
        ${lowStockSql}

        /* Customers hôm nay (chỉ khi có cột ngày) */
        ${cusDateCol
          ? `
          SELECT COUNT(*) AS newCustomers
          FROM dbo.Customers
          WHERE CAST([${cusDateCol}] AS date) = @today;
        `
          : `SELECT CAST(0 AS int) AS newCustomers;`
        }

        /* Chuỗi theo THÁNG */
        ;WITH m AS (
          SELECT @start AS m
          UNION ALL
          SELECT DATEADD(month, 1, m) FROM m
          WHERE m < DATEFROMPARTS(YEAR(@today), MONTH(@today), 1)
        )
        SELECT 
          m AS d,
          ISNULL(COUNT(DISTINCT o.OrderID), 0) AS orders
        FROM m
        LEFT JOIN dbo.Orders o
          ON DATEFROMPARTS(YEAR(o.[${ordDateCol}]), MONTH(o.[${ordDateCol}]), 1) = m
         AND o.Status ${statusFilter}
        GROUP BY m
        ORDER BY m
        OPTION (MAXRECURSION 512, RECOMPILE);
      `;
    } else {
      sqlText += `
        DECLARE @from date = DATEADD(day, -(@days-1), @today);

        /* KPI hôm nay */
        ;WITH t AS (
          SELECT Revenue = ${revenueExpr}, Orders = COUNT(DISTINCT o.OrderID)
          FROM dbo.Orders o
          ${revenueJoin}
          WHERE o.Status ${statusFilter}
            AND CAST(o.[${ordDateCol}] AS date) = @today
        )
        SELECT ISNULL(Revenue,0) AS revenueToday, ISNULL(Orders,0) AS ordersToday
        FROM t;

        /* Low stock */
        ${lowStockSql}

        /* Customers hôm nay (chỉ khi có cột ngày) */
        ${cusDateCol
          ? `
          SELECT COUNT(*) AS newCustomers
          FROM dbo.Customers
          WHERE CAST([${cusDateCol}] AS date) = @today;
        `
          : `SELECT CAST(0 AS int) AS newCustomers;`
        }

        /* Chuỗi theo NGÀY */
        ;WITH d AS (
          SELECT @from AS d
          UNION ALL
          SELECT DATEADD(day,1,d) FROM d WHERE d < @today
        )
        SELECT 
          d AS d,
          ISNULL(COUNT(DISTINCT o.OrderID),0) AS orders
        FROM d
        LEFT JOIN dbo.Orders o
          ON CAST(o.[${ordDateCol}] AS date) = d
         AND o.Status ${statusFilter}
        GROUP BY d
        ORDER BY d
        OPTION (MAXRECURSION 200, RECOMPILE);
      `;
    }

    const rs = await pool.request()
      .input('days', sql.Int, days)
      .input('months', sql.Int, months)
      .input('lowThreshold', sql.Int, lowThreshold)
      .input('includeInactive', sql.Bit, includeInactive ? 1 : 0)
      .query(sqlText);

    const kpi    = rs.recordsets[0][0] || { revenueToday: 0, ordersToday: 0 };
    const low    = rs.recordsets[1][0]?.lowStock ?? 0;
    const cust   = rs.recordsets[2][0]?.newCustomers ?? 0;
    const series = rs.recordsets[3] || [];

    const labels = series.map((r) => {
      const d = r.d instanceof Date ? r.d : new Date(r.d);
      return granularity === 'month'
        ? d.toISOString().slice(0, 7)   // yyyy-MM
        : d.toISOString().slice(0, 10); // yyyy-MM-dd
    });
    const values = series.map((r) => Number(r.orders) || 0);

    return res.json({
      kpis: {
        revenueToday: Number(kpi.revenueToday) || 0,
        ordersToday:  Number(kpi.ordersToday)  || 0,
        lowStock:     Number(low)              || 0,
        newCustomers: Number(cust)             || 0,
        lowThreshold,
        includeInactive
      },
      ordersSeries: { labels, values, granularity }
    });
  } catch (err) {
    console.error('[admin.getDashboard] ', err);
    return res.status(500).json({ message: 'Failed to load dashboard', error: err.message });
  }
};

/* ===================== GET /api/admin/low-variant-product-ids ===================== */
exports.getLowVariantProductIds = async (req, res) => {
  const lowThreshold = parseInt(req.query.lowThreshold || req.query.threshold || '10', 10);
  const includeInactive =
    String(req.query.includeInactive || '0') === '1' ||
    String(req.query.includeInactive || 'false').toLowerCase() === 'true';

  try {
    const pool = await getPool();
    const rs = await pool.request()
      .input('lowThreshold', sql.Int, lowThreshold)
      .input('includeInactive', sql.Bit, includeInactive ? 1 : 0)
      .query(`
        SET NOCOUNT ON;

        /* Biến thể thấp + đếm distinct sản phẩm */
        WITH base AS (
          SELECT po.ProductID
          FROM dbo.ProductOptions po
          JOIN dbo.Products p ON p.ProductID = po.ProductID
          WHERE ISNULL(po.Stock,0) <= @lowThreshold
            AND (@includeInactive = 1 OR ISNULL(p.IsActive,1) = 1)
        )
        SELECT 
          (SELECT COUNT(*) FROM dbo.ProductOptions po
             JOIN dbo.Products p ON p.ProductID = po.ProductID
             WHERE ISNULL(po.Stock,0) <= @lowThreshold
               AND (@includeInactive = 1 OR ISNULL(p.IsActive,1) = 1)
          )            AS variantCount,
          (SELECT COUNT(DISTINCT ProductID) FROM base) AS productCount;

        SELECT DISTINCT ProductID FROM base ORDER BY ProductID;
      `);

    const head = rs.recordsets[0][0] || { variantCount: 0, productCount: 0 };
    const ids  = (rs.recordsets[1] || []).map(r => r.ProductID);
    res.json({ variantCount: head.variantCount, productCount: head.productCount, productIds: ids });
  } catch (err) {
    console.error('[admin.getLowVariantProductIds]', err);
    res.status(500).json({ message: 'Failed to load low-variant products', error: err.message });
  }
};
