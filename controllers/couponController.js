const { getPool, sql } = require('../config/db');

// Lấy tất cả Coupons
const getAllCoupons = async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query('SELECT * FROM Coupons');
        res.json(result.recordset);
    } catch (err) {
        console.error('getAllCoupons error:', err);
        res.status(500).json({
            message: 'Lỗi khi lấy phiếu giảm giá',
            error: err.message,
        });
    }
};

// Thêm Coupon mới
const addCoupon = async (req, res) => {
    const {
        Code,
        Name,
        DiscountType,
        DiscountValue,
        MinOrderTotal,
        MaxDiscount,
        StartDate,
        EndDate,
        UsageLimit,
        PerUserLimit,
        IsActive
    } = req.body;

    try {
        const pool = await getPool();

        const startDateJs = StartDate ? new Date(StartDate) : new Date();
        const endDateJs = EndDate ? new Date(EndDate) : null;

        const result = await pool.request()
            .input('Code', sql.NVarChar, Code)
            .input('Name', sql.NVarChar, Name || null)
            .input('DiscountType', sql.NVarChar, DiscountType || 'PERCENT')
            .input('DiscountValue', sql.Float, DiscountValue)
            .input('MinOrderTotal', sql.Float, MinOrderTotal ?? null)
            .input('MaxDiscount', sql.Float, MaxDiscount ?? null)
            .input('StartDate', sql.DateTime, startDateJs)
            .input('EndDate', sql.DateTime, endDateJs)
            .input('UsageLimit', sql.Int, UsageLimit ?? null)
            .input('PerUserLimit', sql.Int, PerUserLimit ?? null)
            .input('IsActive', sql.Bit, IsActive === false ? 0 : 1)
            .input('CreatedAt', sql.DateTime, new Date())
            .query(`
                INSERT INTO Coupons
                    (Code, Name, DiscountType, DiscountValue,
                     MinOrderTotal, MaxDiscount,
                     StartDate, EndDate,
                     UsageLimit, PerUserLimit,
                     IsActive, CreatedAt)
                OUTPUT INSERTED.*
                VALUES
                    (@Code, @Name, @DiscountType, @DiscountValue,
                     @MinOrderTotal, @MaxDiscount,
                     @StartDate, @EndDate,
                     @UsageLimit, @PerUserLimit,
                     @IsActive, @CreatedAt)
            `);

        const inserted = result.recordset[0];
        res.status(201).json(inserted);
    } catch (err) {
        console.error('addCoupon error:', err);
        res.status(500).json({
            message: 'Lỗi khi thêm phiếu giảm giá',
            error: err.message,
        });
    }
};

// Cập nhật Coupon
const updateCoupon = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const {
        Code,
        Name,
        DiscountType,
        DiscountValue,
        MinOrderTotal,
        MaxDiscount,
        StartDate,
        EndDate,
        UsageLimit,
        PerUserLimit,
        IsActive,
    } = req.body;

    try {
        const pool = await getPool();

        const startDateJs = StartDate ? new Date(StartDate) : new Date();
        const endDateJs = EndDate ? new Date(EndDate) : null;

        const result = await pool.request()
            .input('CouponID', sql.Int, id)
            .input('Code', sql.NVarChar, Code)
            .input('Name', sql.NVarChar, Name || null)
            .input('DiscountType', sql.NVarChar, DiscountType || 'PERCENT')
            .input('DiscountValue', sql.Float, DiscountValue)
            .input('MinOrderTotal', sql.Float, MinOrderTotal ?? null)
            .input('MaxDiscount', sql.Float, MaxDiscount ?? null)
            .input('StartDate', sql.DateTime, startDateJs)
            .input('EndDate', sql.DateTime, endDateJs)
            .input('UsageLimit', sql.Int, UsageLimit ?? null)
            .input('PerUserLimit', sql.Int, PerUserLimit ?? null)
            .input('IsActive', sql.Bit, IsActive === false ? 0 : 1)
            .query(`
                UPDATE Coupons
                SET Code = @Code,
                    Name = @Name,
                    DiscountType = @DiscountType,
                    DiscountValue = @DiscountValue,
                    MinOrderTotal = @MinOrderTotal,
                    MaxDiscount = @MaxDiscount,
                    StartDate = @StartDate,
                    EndDate = @EndDate,
                    UsageLimit = @UsageLimit,
                    PerUserLimit = @PerUserLimit,
                    IsActive = @IsActive
                WHERE CouponID = @CouponID;

                SELECT * FROM Coupons WHERE CouponID = @CouponID;
            `);

        const updated = result.recordset[0];
        if (!updated) {
            return res.status(404).json({ message: 'Không tìm thấy coupon để cập nhật' });
        }

        res.json(updated);
    } catch (err) {
        console.error('updateCoupon error:', err);
        res.status(500).json({
            message: 'Lỗi khi cập nhật phiếu giảm giá',
            error: err.message,
        });
    }
};

// Xóa Coupon
const deleteCoupon = async (req, res) => {
    const id = parseInt(req.params.id, 10);

    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('CouponID', sql.Int, id)
            .query('DELETE FROM Coupons WHERE CouponID = @CouponID');

        // result.rowsAffected[0] = số dòng bị xóa
        if (!result.rowsAffected[0]) {
            return res.status(404).json({ message: 'Không tìm thấy coupon để xóa' });
        }

        res.status(204).send(); // Flutter đang chấp nhận 200 hoặc 204
    } catch (err) {
        console.error('deleteCoupon error:', err);
        res.status(500).json({
            message: 'Lỗi khi xóa phiếu giảm giá',
            error: err.message,
        });
    }
};

module.exports = {
    getAllCoupons,
    addCoupon,
    updateCoupon,
    deleteCoupon,
};
