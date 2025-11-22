const { DataTypes } = require('sequelize');
const sequelize = require('../db'); // Đảm bảo bạn đã cấu hình db.js

const CartItem = sequelize.define('CartItem', {
  productId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
});

module.exports = CartItem;
