const bcrypt = require('bcryptjs');

(async () => {
  const plain = '14122003';           // mật khẩu bạn muốn đặt
  const hash = await bcrypt.hash(plain, 10);
  console.log(hash);
})();
