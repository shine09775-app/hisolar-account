// ================================================================
//  CATEGORY MAP  —  แก้ไขไฟล์นี้เพื่อ maintain การจัดกลุ่มบัญชี
//
//  keywords : ข้อความที่ค้นหาใน description ของรายการธนาคาร
//             แนะนำใส่รหัสบัญชี "X####" เพื่อความแม่นยำ
//  group    : ชื่อหมวดหมู่ / Supplier ที่แสดงในกราฟและรายงาน
//  color    : สีในกราฟ (CSS hex)
// ================================================================
const CATEGORY_MAP = [
  {
    group: 'บ้านทุ่งรุ่ง',
    color: '#dc2626',
    keywords: ['X8049', 'X1376', 'บ้านทุ่งรุ้', 'บ้านทุ่งรุ่ง'],
  },
  {
    group: 'KSHER',
    color: '#f59e0b',
    keywords: ['X3750', 'KSHER'],
  },
  {
    group: 'ร้านเจ๊เฮีย / วัสดุ',
    color: '#f97316',
    keywords: ['X5184', 'สมาร์ทที'],
  },
  {
    group: 'ค่าแรง/เงินเดือน',
    color: '#ec4899',
    keywords: ['X5614', 'X9611', 'X2577', 'X0185', 'X6027', 'X0474', 'X3478'],
  },
  {
    group: 'แสงทวีทรัพย์',
    color: '#fb923c',
    keywords: ['X9240', 'สห้างค้า20', 'แสงทวี'],
  },
  {
    group: 'Advance ชัยวัฒน์',
    color: '#fb7185',
    keywords: ['X3006', 'X8624'],
  },
  {
    group: 'KLUNGFAIFA',
    color: '#eab308',
    keywords: ['X8707', 'KLUNGFAIFA', 'คลังฟ้า'],
  },
  {
    group: 'วีระชัยการไฟฟ้า',
    color: '#a3e635',
    keywords: ['X6592', 'วีระชัย'],
  },
  {
    group: 'เอเอ็มออโต',
    color: '#22c55e',
    keywords: ['X9482'],
  },
  {
    group: 'ซื้อสินค้า/วัสดุ',
    color: '#f97316',
    keywords: ['X6663', 'X5441', 'X7753', 'X8733', 'X4778', 'X9858', 'X1569', 'X6939', 'X1759', 'X7798', 'X0176', 'X8530'],
  },
  {
    group: 'ค่าใช้จ่ายอื่น',
    color: '#94a3b8',
    keywords: ['X8247', 'X0537', 'X3573', 'X8126', 'X9558', 'X3475', 'GSB X3475'],
  },
  {
    group: 'ค่าภาษี/บริการ',
    color: '#64748b',
    keywords: ['กรมสรรพากร', 'Ref X5690', 'Ref X7817', 'SMS', 'HOMEPRO', 'Ref X3008', 'Ref X1959', 'KTB Ref X9381', 'KTB Ref X6951'],
  },
]

// ================================================================
//  ACCOUNT LABELS  —  กำหนดชื่อแสดงของแต่ละบัญชี
//  match : ฟังก์ชันตรวจว่า account string ที่เก็บใน DB ตรงกับบัญชีนี้ไหม
// ================================================================
const ACCOUNT_LABELS = [
  {
    display: 'บัญชีบริษัท',
    match: (a) => !a ? false : ['hisolar', '098-1-85467-5', 'แฮ้โซลาร์', 'hi solar', 'sun energy']
      .some(k => a.toLowerCase().includes(k)),
  },
  {
    display: 'บัญชีคู่',
    match: (a) => !a ? false : ['098-3-36149-8', 'อาภาพร', 'วสันต์', 'บัญชีคู่', 'pany']
      .some(k => a.toLowerCase().includes(k)),
  },
]

// คืนชื่อแสดงจากค่า account ดิบใน DB
function displayAccount(raw) {
  if (!raw) return '—'
  const found = ACCOUNT_LABELS.find(l => l.match(raw))
  return found ? found.display : raw
}

// ---- Extract counterparty name from memo/description ----
// ดึงชื่อผู้โอน/ผู้รับโอนจาก description ของธนาคาร
function extractCounterparty(memo) {
  if (!memo) return '—'
  // รูปแบบ: [ธนาคาร?] X#### [ชื่อ]++
  const m = memo.match(/X\d{4}\s+([^+\n]{2,50})/)
  if (m) return m[1].trim().replace(/\+\+\s*$/, '')
  // กรณีพิเศษ
  if (memo.includes('กรมสรรพากร')) return 'กรมสรรพากร'
  if (memo.includes('HOMEPRO'))    return 'HomePro'
  if (memo.includes('SMS'))        return 'ค่าบริการ SMS'
  if (memo.includes('QR Payment')) return 'QR Payment'
  // fallback
  return memo.replace(/\+\+\s*$/, '').trim().substring(0, 45)
}

// ---- Resolve category group from memo ----
// คืนชื่อกลุ่ม Supplier จาก CATEGORY_MAP
function resolveCategory(memo) {
  if (!memo) return 'อื่นๆ'
  for (const { group, keywords } of CATEGORY_MAP) {
    if (keywords.some(k => memo.includes(k))) return group
  }
  return 'อื่นๆ'
}
