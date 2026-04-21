// ================================================================
//  CATEGORY MAP â€” à¹à¸à¹‰à¹„à¸‚à¹„à¸Ÿà¸¥à¹Œà¸™à¸µà¹‰à¹€à¸žà¸·à¹ˆà¸­ maintain à¸à¸²à¸£à¸ˆà¸±à¸”à¸à¸¥à¸¸à¹ˆà¸¡à¸šà¸±à¸à¸Šà¸µ
//
//  keywords : à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸—à¸µà¹ˆà¸„à¹‰à¸™à¸«à¸²à¹ƒà¸™ description à¸‚à¸­à¸‡à¸£à¸²à¸¢à¸à¸²à¸£à¸˜à¸™à¸²à¸„à¸²à¸£
//             à¹à¸™à¸°à¸™à¸³à¹ƒà¸ªà¹ˆà¸£à¸«à¸±à¸ªà¸šà¸±à¸à¸Šà¸µ "X####" à¹€à¸žà¸·à¹ˆà¸­à¸„à¸§à¸²à¸¡à¹à¸¡à¹ˆà¸™à¸¢à¸³
//  group    : à¸Šà¸·à¹ˆà¸­à¸«à¸¡à¸§à¸”à¸«à¸¡à¸¹à¹ˆ / Supplier à¸—à¸µà¹ˆà¹à¸ªà¸”à¸‡à¹ƒà¸™à¸à¸£à¸²à¸Ÿà¹à¸¥à¸°à¸£à¸²à¸¢à¸‡à¸²à¸™
//  color    : à¸ªà¸µà¹ƒà¸™à¸à¸£à¸²à¸Ÿ (CSS hex)
// ================================================================
const CATEGORY_MAP = [
  {
    group: 'บ้านทุ่งรุ่ง',
    color: '#dc2626',
    keywords: ['X8049', 'X1376', 'บ้านทุ่งรุ้ง', 'บ้านทุ่งรุ่ง'],
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
    group: 'คลังไฟฟ้า',
    color: '#eab308',
    keywords: ['X8707', 'KLUNGFAIFA', 'คลังไฟฟ้า'],
  },
  {
    group: 'วีระชัยการไฟฟ้า',
    color: '#a3e635',
    keywords: ['X6592', 'วีระชัย'],
  },
  {
    group: 'เอ็มเอ็มออโต้',
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
//  ACCOUNT LABELS â€” à¸à¸³à¸«à¸™à¸”à¸Šà¸·à¹ˆà¸­à¹à¸ªà¸”à¸‡à¸‚à¸­à¸‡à¹à¸•à¹ˆà¸¥à¸°à¸šà¸±à¸à¸Šà¸µ
//  match : à¸Ÿà¸±à¸‡à¸à¹Œà¸Šà¸±à¸™à¸•à¸£à¸§à¸ˆà¸§à¹ˆà¸² account string à¸—à¸µà¹ˆà¹€à¸à¹‡à¸šà¹ƒà¸™ DB à¸•à¸£à¸‡à¸à¸±à¸šà¸šà¸±à¸à¸Šà¸µà¸™à¸µà¹‰à¹„à¸«à¸¡
// ================================================================
const ACCOUNT_LABELS = [
  {
    key: 'company',
    display: 'บัญชีบริษัท',
    match: (a) => !a ? false : [
      'hisolar',
      '098-1-85467-5',
      'à¹„à¸®à¹‚à¸‹à¸¥à¸²à¸£à¹Œ',
      'hi solar',
      'sun energy',
      'บัญชีบริษัท',
      'ไฮโซลาร์',
      'ไฮ โซลาร์',
      'บจก. ไฮโซลาร์',
      'ไฮโซลาร์ซันเอ',
      'ไฮโซลาร์ซันเอ็นเนอร์ยี่',
      'sunenergy',
      'ซันเอ',
      'ซันเอ็น',
    ]
      .some(k => a.toLowerCase().includes(k)),
  },
  {
    key: 'joint',
    display: 'บัญชีคู่',
    match: (a) => !a ? false : [
      '098-3-36149-8',
      'à¸šà¸±à¸à¸Šà¸µà¸„à¸¹à¹ˆ',
      'บัญชีคู่',
      'น.ส. อาภาพร เทพจันทร์ และ นาย วสันต์ ปานแย้ม',
    ]
      .some(k => a.toLowerCase().includes(k)),
  },
]

// à¸„à¸·à¸™à¸Šà¸·à¹ˆà¸­à¹à¸ªà¸”à¸‡à¸ˆà¸²à¸à¸„à¹ˆà¸² account à¸”à¸´à¸šà¹ƒà¸™ DB
function displayAccount(raw) {
  if (!raw) return '—'
  if (String(raw).includes('à¸šà¸±à¸à¸Šà¸µà¸šà¸£à¸´à¸©à¸±à¸—')) return 'บัญชีบริษัท'
  if (String(raw).includes('à¸šà¸±à¸à¸Šà¸µà¸„à¸¹à¹ˆ')) return 'บัญชีคู่'
  if (String(raw).includes('น.ส. อาภาพร เทพจันทร์ และ นาย วสันต์ ปานแย้ม')) return 'บัญชีคู่'
  const found = ACCOUNT_LABELS.find(l => l.match(raw))
  return found ? found.display : raw
}

// ---- Extract counterparty name from memo/description ----
// à¸”à¸¶à¸‡à¸Šà¸·à¹ˆà¸­à¸œà¸¹à¹‰à¹‚à¸­à¸™/à¸œà¸¹à¹‰à¸£à¸±à¸šà¹‚à¸­à¸™à¸ˆà¸²à¸ description à¸‚à¸­à¸‡à¸˜à¸™à¸²à¸„à¸²à¸£
function extractCounterparty(memo) {
  if (!memo) return '—'
  // à¸£à¸¹à¸›à¹à¸šà¸š: [à¸˜à¸™à¸²à¸„à¸²à¸£?] X#### [à¸Šà¸·à¹ˆà¸­]++
  const m = memo.match(/X\d{4}\s+([^+\n]{2,50})/)
  if (m) return m[1].trim().replace(/\+\+\s*$/, '')
  // à¸à¸£à¸“à¸µà¸žà¸´à¹€à¸¨à¸©
  if (memo.includes('กรมสรรพากร')) return 'กรมสรรพากร'
  if (memo.includes('HOMEPRO')) return 'HomePro'
  if (memo.includes('SMS')) return 'ค่าบริการ SMS'
  if (memo.includes('QR Payment')) return 'QR Payment'
  // fallback
  return memo.replace(/\+\+\s*$/, '').trim().substring(0, 45)
}

// ---- Resolve category group from memo ----
// à¸„à¸·à¸™à¸Šà¸·à¹ˆà¸­à¸à¸¥à¸¸à¹ˆà¸¡ Supplier à¸ˆà¸²à¸ CATEGORY_MAP
function resolveCategory(memo) {
  if (!memo) return 'อื่นๆ'
  for (const { group, keywords } of CATEGORY_MAP) {
    if (keywords.some(k => memo.includes(k))) return group
  }
  return 'อื่นๆ'
}

