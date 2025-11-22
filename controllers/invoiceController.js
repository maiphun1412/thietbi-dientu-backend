const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { getPool, sql } = require('../config/db');

function nfc(v) {
  if (v == null) return '';
  try { return String(v).normalize('NFC'); } catch { return String(v); }
}
const money = (n) =>
  (Number(n || 0)).toLocaleString('vi-VN', { maximumFractionDigits: 0 }) + 'đ';

exports.getInvoicePdf = async (req, res) => {
  const orderId = Number(req.params.orderId || 0);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ message: 'orderId invalid' });
  }

  try {
    const pool = await getPool();

    // ===== Header =====
    const headRs = await pool.request()
      .input('oid', sql.Int, orderId)
      .query(`
        SELECT
          o.OrderID, o.CustomerID, o.AddressID, o.Total, o.PaymentMethod,
          o.Status, o.CreatedAt, o.AssignedShipperID,
          c.FullName AS CustomerName, c.Phone AS CustomerPhone,
          a.Line1, a.District, a.City, a.Province,
          s.Name AS ShipperName, s.Phone AS ShipperPhone, s.LicensePlate
        FROM dbo.Orders o
        LEFT JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
        LEFT JOIN dbo.Addresses a ON a.AddressID  = o.AddressID
        LEFT JOIN dbo.Shippers  s ON s.ShipperID  = o.AssignedShipperID
        WHERE o.OrderID = @oid
      `);

    if (headRs.recordset.length === 0) {
      return res.status(404).json({ message: 'Order not found' });
    }
    const h = headRs.recordset[0];

    // ===== Items (join Products.Name) =====
    const itemsRs = await pool.request()
      .input('oid', sql.Int, orderId)
      .query(`
        SELECT i.OrderItemID, i.ProductID, p.Name AS ProductName, i.Quantity, i.UnitPrice
        FROM dbo.OrderItems i
        LEFT JOIN dbo.Products p ON p.ProductID = i.ProductID
        WHERE i.OrderID = @oid
        ORDER BY i.OrderItemID
      `);
    const items = itemsRs.recordset || [];

    // ===== PDF =====
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${orderId}.pdf"`);

    const doc = new PDFDocument({ margin: 36, size: 'A4' });
    doc.pipe(res);

    // --- Font: Roboto Regular + Bold (TTF) ---
    const fontRegular = path.join(__dirname, '../public/fonts/Roboto-Regular.ttf');
    const fontBold    = path.join(__dirname, '../public/fonts/Roboto-Bold.ttf');

    if (fs.existsSync(fontRegular)) doc.registerFont('VN', fontRegular);
    if (fs.existsSync(fontBold))    doc.registerFont('VNB', fontBold);

    // fallback nếu thiếu file: vẫn cố chạy nhưng có thể vỡ dấu
    try { doc.font('VN'); } catch { /* ignore */ }

    // ===== Title =====
    try { doc.font('VNB'); } catch { /* ignore */ }
    doc.fontSize(18).text(nfc(`HÓA ĐƠN / INVOICE #${orderId}`), { align: 'center' });
    doc.moveDown(0.5);

    const createdAt = h.CreatedAt instanceof Date ? h.CreatedAt : new Date(h.CreatedAt);
    try { doc.font('VN'); } catch { /* ignore */ }
    doc.fontSize(10).text(nfc(`Ngày: ${createdAt.toLocaleString('vi-VN')}`));
    doc.moveDown();

    // ===== Customer =====
    try { doc.font('VNB'); } catch { /* ignore */ }
    doc.fontSize(12).text(nfc('Khách hàng'), { underline: true });
    try { doc.font('VN'); } catch { /* ignore */ }
    doc.fontSize(10)
      .text(nfc(`Họ tên: ${h.CustomerName || ''}`))
      .text(nfc(`Điện thoại: ${h.CustomerPhone || ''}`))
      .text(nfc(`Địa chỉ: ${[h.Line1, h.District, h.City, h.Province].filter(Boolean).map(nfc).join(', ')}`));
    doc.moveDown();

    // ===== Shipper =====
    if (h.ShipperName) {
      try { doc.font('VNB'); } catch { /* ignore */ }
      doc.fontSize(12).text(nfc('Shipper'), { underline: true });
      try { doc.font('VN'); } catch { /* ignore */ }
      doc.fontSize(10)
        .text(nfc(`Tên: ${h.ShipperName}`))
        .text(nfc(`Điện thoại: ${h.ShipperPhone || ''}`))
        .text(nfc(`Biển số: ${h.LicensePlate || ''}`));
      doc.moveDown();
    }

    /* ===== Table (layout động, không lệch cột) ===== */
    try { doc.font('VNB'); } catch {}
    doc.fontSize(12).text(nfc('Chi tiết đơn hàng'), { underline: true });
    doc.moveDown(0.3);

    try { doc.font('VN'); } catch {}
    doc.fontSize(10);

    // vùng usable theo lề trang hiện tại
    const L = doc.page.margins.left;
    const R = doc.page.width - doc.page.margins.right;
    const tableW = R - L;

    // Định nghĩa độ rộng cột
    const colW = { qty: 40, price: 85, line: 95 };
    colW.name = tableW - colW.qty - colW.price - colW.line - 20; // 20 = padding

    // Toạ độ x cho từng cột
    const X = {
      qty:   L,
      name:  L + colW.qty + 8,
      price: R - colW.line - colW.price - 8,
      line:  R - colW.line
    };

    let y = doc.y;
    doc.text(nfc('SL'),        X.qty,  y, { width: colW.qty });
    doc.text(nfc('Sản phẩm'),  X.name, y, { width: colW.name });
    doc.text(nfc('Đơn giá'),   X.price,y, { width: colW.price, align: 'right' });
    doc.text(nfc('Thành tiền'),X.line, y, { width: colW.line,  align: 'right' });

    y = doc.y + 4;
    doc.moveTo(L, y).lineTo(R, y).stroke();
    y += 6;

    let sum = 0;
    for (const it of items) {
      const qty   = Number(it.Quantity || 0);
      const price = Number(it.UnitPrice || 0);
      const line  = qty * price;
      sum += line;

      const hName = doc.heightOfString(nfc(it.ProductName || `#${it.ProductID}`), {
        width: colW.name
      });
      const rowH = Math.max(14, hName + 2);

      doc.text(String(qty), X.qty,  y, { width: colW.qty });
      doc.text(nfc(it.ProductName || `#${it.ProductID}`), X.name, y, { width: colW.name });
      doc.text(money(price), X.price, y, { width: colW.price, align: 'right' });
      doc.text(money(line),  X.line,  y, { width: colW.line,  align: 'right' });

      y += rowH;
    }

    doc.moveTo(L, y).lineTo(R, y).stroke();
    y += 8;

    // ===== Totals box gọn bên phải =====
    const boxW = 220;
    const boxH = 60;
    const boxX = R - boxW;
    const boxY = y;

    doc.roundedRect(boxX, boxY, boxW, boxH, 6).stroke();

    const labelX = boxX + 10;
    const valueX = boxX + boxW - 10;
    const lineGap = 18;

    try { doc.font('VNB'); } catch {}
    doc.text(nfc('Tổng cộng:'), labelX, boxY + 8, { width: boxW - 20 });
    try { doc.font('VN'); } catch {}
    doc.text(money(sum), valueX, boxY + 8, { width: 0, align: 'right' });

    doc.text(nfc('Phương thức thanh toán:'), labelX, boxY + 8 + lineGap, { width: boxW - 20 });
    doc.text(nfc(h.PaymentMethod || ''), valueX, boxY + 8 + lineGap, { width: 0, align: 'right' });

    doc.text(nfc('Trạng thái đơn:'), labelX, boxY + 8 + lineGap * 2, { width: boxW - 20 });
    doc.text(nfc(h.Status || ''), valueX, boxY + 8 + lineGap * 2, { width: 0, align: 'right' });

    doc.moveDown(2);
    /* ===== End table block ===== */

    doc.end();
  } catch (e) {
    console.error('[invoice.getInvoicePdf] error:', e);
    if (!res.headersSent) res.status(500).json({ message: 'Generate invoice failed' });
    else try { res.end(); } catch {}
  }
};
