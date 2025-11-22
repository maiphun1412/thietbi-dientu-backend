const { getPool, sql } = require('../config/db');

// Lấy tất cả thẻ bảo hành
const getAllWarrantyCards = async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query('SELECT * FROM WarrantyCards');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi khi tải thẻ bảo hành', error: err.message });
    }
};

// Thêm thẻ bảo hành mới
const addWarrantyCard = async (req, res) => {
    const { OrderItemID, SerialNumber, WarrantyMonths, StartDate, EndDate, Status, Note } = req.body;

    try {
        const pool = await getPool();
        await pool.request()
            .input('OrderItemID', sql.Int, OrderItemID)
            .input('SerialNumber', sql.NVarChar, SerialNumber)
            .input('WarrantyMonths', sql.Int, WarrantyMonths)
            .input('StartDate', sql.DateTime, StartDate)
            .input('EndDate', sql.DateTime, EndDate)
            .input('Status', sql.NVarChar, Status)
            .input('Note', sql.NVarChar, Note || null)
            .query(`INSERT INTO WarrantyCards 
                (OrderItemID, SerialNumber, WarrantyMonths, StartDate, EndDate, Status, Note)
                VALUES
                (@OrderItemID, @SerialNumber, @WarrantyMonths, @StartDate, @EndDate, @Status, @Note)`);

        res.json({ message: 'Đã thêm thẻ bảo hành' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi thêm thẻ bảo hành', error: err.message });
    }
};

module.exports = { getAllWarrantyCards, addWarrantyCard };
