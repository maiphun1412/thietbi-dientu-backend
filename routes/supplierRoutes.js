// routes/supplierRoutes.js
const express = require('express');
const {
  getAllSuppliers,
  addSupplier,
  updateSupplier,
  deleteSupplier,
} = require('../controllers/supplierController');

const router = express.Router();

// GET /api/suppliers
router.get('/', getAllSuppliers);

// POST /api/suppliers
router.post('/', addSupplier);

// PUT /api/suppliers/:id
router.put('/:id', updateSupplier);

// DELETE /api/suppliers/:id
router.delete('/:id', deleteSupplier);

module.exports = router;
