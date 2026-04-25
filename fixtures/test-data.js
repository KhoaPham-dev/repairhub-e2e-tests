/**
 * Realistic Vietnamese test data for RepairHub E2E tests.
 *
 * Naming pattern: uses common Vietnamese given names / surnames.
 * Phone numbers follow Vietnamese mobile format (09x / 07x / 08x, 10 digits).
 */

const { v4: uuidv4 } = require('crypto');

// Unique-per-run suffix to avoid DB conflicts when tests run repeatedly
const RUN_ID = Date.now().toString().slice(-6);

// Monotonic counter — guarantees unique phone numbers even when uid()'s
// random suffix contains no digits (which would otherwise cause collisions
// after padEnd fills with the same character).
let _seq = 0;

function uid() {
  return `${RUN_ID}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniquePhone(prefix) {
  const seq = String(++_seq).padStart(4, '0');
  return `${prefix}${RUN_ID.slice(0, 3)}${seq}`;
}

// ─── Credentials ─────────────────────────────────────────────────────────────
const ADMIN_CREDS = { username: 'admin', password: 'admin123' };
const TECH_CREDS = { username: 'technician', password: 'tech123' };

// ─── Vietnamese customer fixtures ────────────────────────────────────────────
function makeCustomer(overrides = {}) {
  const id = uid();
  return {
    phone: uniquePhone('090'),
    name: `Nguyễn Văn Bình ${id}`,
    address: `${id} Đường Lê Lợi, Quận 1, TP.HCM`,
    type: 'RETAIL',
    notes: 'Khách hàng thường xuyên',
    ...overrides,
  };
}

function makePartnerCustomer(overrides = {}) {
  const id = uid();
  return {
    phone: uniquePhone('087'),
    name: `Công ty TNHH Điện Tử Phương Nam ${id}`,
    address: `${id} Đường Nguyễn Thị Minh Khai, Quận 3, TP.HCM`,
    type: 'PARTNER',
    notes: 'Đối tác sửa chữa loa cao cấp',
    ...overrides,
  };
}

// ─── Vietnamese branch fixtures ───────────────────────────────────────────────
function makeBranch(overrides = {}) {
  const id = uid();
  return {
    name: `Chi nhánh Quận ${id}`,
    address: `${id} Đường Trần Hưng Đạo, TP.HCM`,
    phone: uniquePhone('028'),
    manager_name: `Trần Thị Hoa ${id}`,
    ...overrides,
  };
}

// ─── Vietnamese order fixtures ────────────────────────────────────────────────
const DEVICE_NAMES_VI = [
  'Loa JBL Flip 6',
  'Loa Sony SRS-XB43',
  'Tai nghe Sony WH-1000XM5',
  'Tai nghe Bose QuietComfort 45',
  'Loa Marshall Emberton',
  'Tai nghe Apple AirPods Pro',
];

const FAULT_DESCRIPTIONS_VI = [
  'Loa không phát âm thanh, kiểm tra mạch nguồn',
  'Tai nghe bên trái bị mất tiếng khi vận động',
  'Pin xuống nhanh, sạc không vào',
  'Có tiếng rè khi âm lượng cao',
  'Nút điều chỉnh âm lượng bị kẹt',
  'Loa phát ra tiếng kêu bất thường',
];

const SERIAL_EXAMPLES = [
  'SN-2024-VN-00123',
  'JBL-FLIP6-VN-45892',
  'SONY-XM5-2025-78901',
  'BOSE-QC45-VN-23410',
];

function makeOrder(customerId, branchId, overrides = {}) {
  const deviceIdx = Math.floor(Math.random() * DEVICE_NAMES_VI.length);
  const faultIdx = Math.floor(Math.random() * FAULT_DESCRIPTIONS_VI.length);
  return {
    customer_id: customerId,
    branch_id: branchId,
    product_type: ['SPEAKER', 'HEADPHONE', 'OTHER'][deviceIdx % 3],
    device_name: DEVICE_NAMES_VI[deviceIdx],
    serial_imei: SERIAL_EXAMPLES[deviceIdx % SERIAL_EXAMPLES.length],
    accessories: 'Cáp sạc, túi đựng',
    fault_description: FAULT_DESCRIPTIONS_VI[faultIdx],
    quotation: [150000, 250000, 350000, 500000, 750000][faultIdx % 5],
    ...overrides,
  };
}

// ─── Status workflow ──────────────────────────────────────────────────────────
const STATUS_FLOW = [
  'TIEP_NHAN',
  'DANG_KIEM_TRA',
  'BAO_GIA',
  'CHO_LINH_KIEN',
  'DANG_SUA_CHUA',
  'KIEM_TRA_LAI',
  'SUA_XONG',
  'DA_GIAO',
];

const STATUS_LABELS_VI = {
  TIEP_NHAN: 'Tiếp nhận',
  DANG_KIEM_TRA: 'Đang kiểm tra',
  BAO_GIA: 'Báo giá',
  CHO_LINH_KIEN: 'Chờ linh kiện',
  DANG_SUA_CHUA: 'Đang sửa chữa',
  KIEM_TRA_LAI: 'Kiểm tra lại',
  SUA_XONG: 'Sửa xong',
  DA_GIAO: 'Đã giao',
  HUY_TRA_MAY: 'Huỷ/Trả máy',
};

const TERMINAL_STATUSES = ['DA_GIAO', 'HUY_TRA_MAY'];

module.exports = {
  ADMIN_CREDS,
  TECH_CREDS,
  makeCustomer,
  makePartnerCustomer,
  makeBranch,
  makeOrder,
  STATUS_FLOW,
  STATUS_LABELS_VI,
  TERMINAL_STATUSES,
  DEVICE_NAMES_VI,
};
