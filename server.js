require('dotenv').config({ path: './.env' });

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const os = require('os');
const http = require('http');                 // ⬅️ thêm
const { Server } = require('socket.io');      // ⬅️ thêm

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Để xác thực qua proxy/nginx (nếu có)
app.set('trust proxy', 1);

// ===== CORS =====
const CLIENT_URLS = (process.env.CLIENT_URLS || process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Chấp nhận localhost/127.0.0.1, các dải LAN, và danh sách CLIENT_URLS.
// Lưu ý: Mobile app (Flutter http) KHÔNG bị CORS, chỉ web mới cần, nhưng để sẵn.
const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const lanRegex = /^https?:\/\/(?:(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:192\.168\.\d{1,3}\.\d{1,3})|(?:172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}))(?::\d+)?$/i;

const corsDelegate = {
  origin(origin, cb) {
    // origin = undefined khi gọi từ mobile app hoặc tool ⇒ cho qua
    if (!origin) return cb(null, true);
    if (CLIENT_URLS.includes(origin)) return cb(null, true);
    if (localhostRegex.test(origin)) return cb(null, true);
    if (lanRegex.test(origin)) return cb(null, true);
    console.warn(`❌ CORS blocked origin: ${origin}`);
    return cb(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsDelegate));
app.options(/.*/, cors(corsDelegate));

// ===== Body & Cookie parsers (trước routes) =====
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ===== Debug logger (nhẹ) =====
app.use((req, _res, next) => {
  // Hiển thị method, path, ip và Origin (nếu có) để soi nhanh
  const origin = req.headers.origin || '-';
  console.log(`[IN] ${req.method} ${req.originalUrl} | ip=${req.ip} | origin=${origin}`);
  next();
});

// ===== Static =====
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use('/static', express.static(path.join(__dirname, 'public')));

// ===== Health =====
app.get('/api/health', (_req, res) => {
  res.json({ message: 'API chạy ổn định 😎' });
});

// ===== Routes =====
app.use('/api/admin', require('./routes/adminRoutes'));

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const orderItemRoutes = require('./routes/orderItemRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const shipperRoutes = require('./routes/shipperRoutes');
const couponRoutes = require('./routes/couponRoutes');
const warrantyRoutes = require('./routes/warrantyRoutes');
const addressRoutes = require('./routes/addressRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const cartRoutes = require('./routes/cartRoutes');
const adminProductRoutes = require('./routes/adminProductRoutes');
const adminCategoryRoutes = require('./routes/adminCategoryRoutes');
const supplierRoutes = require('./routes/supplierRoutes');
const warehouseRoutes = require('./routes/warehouseRoutes');
const adminUserRoutes = require('./routes/adminUserRoutes');



try {
  const { verifyTransport } = require('./utils/mailer');
  if (typeof verifyTransport === 'function') verifyTransport();
  else console.warn('[MAIL] verifyTransport not exported, skipped');
} catch {
  console.warn('[MAIL] mailer module not available, skipped');
}

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/order-item', orderItemRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/shippers', shipperRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/warrantycards', warrantyRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/admin/products', adminProductRoutes);
app.use('/api/admin/categories', adminCategoryRoutes);
app.use('/api', require('./routes/shipmentRoutes')); // file con KHÔNG có /api ở đầu
app.use('/api/reviews', require('./routes/reviewRoutes'));
app.use('/api/inventory', require('./routes/inventoryRoutes'));
app.use('/api/shipper', require('./routes/shipperRoutes'));
app.use('/api/suppliers', supplierRoutes);
app.use('/api/warehouses', warehouseRoutes);
app.use('/api/admin/users', adminUserRoutes);



// 👉 Mount route in hóa đơn nằm dưới /api/orders
app.use('/api/orders', require('./routes/invoiceRoutes'));

// 👉 Mount route thông báo (per-user)
app.use('/api/notifications', require('./routes/notificationRoutes')); // ⬅️ thêm

// ===== 404 =====
app.use((req, res) => {
  res.status(404).json({ message: 'Not Found' });
});

// ===== Error handler =====
app.use((err, _req, res, _next) => {
  console.error('[GLOBAL ERROR]:', err?.stack || err?.message || err);
  const code = err.status || 500;
  res.status(code).json({
    message: code === 500 ? 'Internal Server Error' : err.message,
  });
});

// ===== Start (HTTP + Socket.IO) =====
const server = http.createServer(app);                                              // ⬅️ thay cho app.listen
const io = new Server(server, {                                                     // ⬅️ thêm
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (CLIENT_URLS.includes(origin)) return cb(null, true);
      if (localhostRegex.test(origin)) return cb(null, true);
      if (lanRegex.test(origin)) return cb(null, true);
      console.warn(`❌ Socket.IO blocked origin: ${origin}`);
      return cb(new Error('Socket.IO CORS blocked'));
    },
    credentials: true,
    methods: ['GET', 'POST'],
  },
});

// Map userId ↔ socketId để emit đúng người dùng
const userSockets = new Map();
io.on('connection', (socket) => {
  socket.on('auth', (userId) => {
    socket.data.userId = Number(userId);
    if (Number.isFinite(socket.data.userId)) {
      userSockets.set(socket.data.userId, socket.id);
      console.log(`[SOCKET] user ${socket.data.userId} connected -> ${socket.id}`);
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.userId) {
      userSockets.delete(socket.data.userId);
      console.log(`[SOCKET] user ${socket.data.userId} disconnected`);
    }
  });
});

// Cho controller truy cập Socket.IO để emit thông báo
app.set('io', io);                     // ⬅️ thêm
app.set('userSockets', userSockets);   // ⬅️ thêm

// Quan trọng: bind 0.0.0.0 để emulator/máy khác truy cập đc
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addresses = Object.values(nets)
    .flat()
    .filter((net) => net.family === 'IPv4' && !net.internal)
    .map((net) => net.address);
  console.log('Allowed origins (.env):', CLIENT_URLS);
  console.log(`✅ Server running on:`);
  console.log(`   • Local:   http://localhost:${PORT}`);
  addresses.forEach((ip) => console.log(`   • LAN:     http://${ip}:${PORT}`));
});
