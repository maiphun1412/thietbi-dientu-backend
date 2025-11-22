const express = require('express');
const {
  getAllWarehouses,
  addWarehouse,
  updateWarehouse,
  deleteWarehouse,
} = require('../controllers/warehouseController');

const router = express.Router();

// GET /api/warehouses
router.get('/', getAllWarehouses);

// POST /api/warehouses
router.post('/', addWarehouse);

// PUT /api/warehouses/:id
router.put('/:id', updateWarehouse);

// DELETE /api/warehouses/:id
router.delete('/:id', deleteWarehouse);

module.exports = router;
