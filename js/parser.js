// ---- CSV + PDF Parser + Hash สำหรับ deduplication ----

// ================================================================
// PDF PARSER  (ใช้ pdf.js ที่โหลดใน browser)
// ================================================================

async function parsePDFFile(file, accountOverride = '') {
  const text = await extractPDFText(file)
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  // ตรวจจับธนาคารจาก text
  const bank = detectBank(text)
  let rows

  if (bank === 'KBANK') rows = parseKBankPDF(lines)
  else if (bank === 'SCB') rows = parseSCBPDF(lines)
  else if (bank === 'KTB') rows = parseKTBPDF(lines)
  else                      rows = parseGenericBankPDF(lines)

  // ใส่ account override และสร้าง hash
  const result = []
  for (const r of rows) {
    if (!r.date || isNaN(r.amount) || r.amount === 0) continue
    if (accountOverride) r.account = accountOverride
    else if (!r.account) r.account = bank || 'Unknown'
    r.hash = await makeHash(r)
    result.push(r)
  }
  return result
}

async function extractPDFText(file) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  let fullText = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    // รวม text items ต่อบรรทัด โดยใช้ y-position grouping
    const items = content.items
    const lineMap = {}
    for (const item of items) {
      const y = Math.round(item.transform[5])
      if (!lineMap[y]) lineMap[y] = []
      lineMap[y].push({ x: item.transform[4], str: item.str })
    }
    const sortedY = Object.keys(lineMap).map(Number).sort((a, b) => b - a)
    for (const y of sortedY) {
      const sortedItems = lineMap[y].sort((a, b) => a.x - b.x)
      fullText += sortedItems.map(i => i.str).join(' ') + '\n'
    }
  }
  return fullText
}

function detectBank(text) {
  const t = text.toLowerCase()
  if (t.includes('kasikorn') || t.includes('กสิกร') || t.includes('kbank')) return 'KBANK'
  if (t.includes('scb') || t.includes('ไทยพาณิชย์') || t.includes('siam commercial')) return 'SCB'
  if (t.includes('กรุงไทย') || t.includes('krungthai') || t.includes('ktb')) return 'KTB'
  if (t.includes('กรุงเทพ') || t.includes('bangkok bank') || t.includes('bbl')) return 'BBL'
  return 'UNKNOWN'
}

// ---- KBank PDF Parser ----
// Format: DD/MM/YY  HH:MM  รายการ  ถอน  ฝาก  ยอดคงเหลือ
function parseKBankPDF(lines) {
  const rows = []
  // pattern: วันที่ เวลา รายการ [ถอน] [ฝาก] ยอดคงเหลือ
  const dateRe = /^(\d{1,2}\/\d{1,2}\/\d{2,4})/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(dateRe)
    if (!m) continue

    const parts = line.replace(/,/g, '').split(/\s+/)
    const date  = parseDateShortBE(m[1])
    if (!date) continue

    // หาตัวเลข amount จาก parts (ถอน/ฝาก คือ 2 ตัวเลขสุดท้ายก่อน balance)
    const nums = parts.filter(p => /^\d+(\.\d+)?$/.test(p)).map(Number)
    // nums ท้ายสุด = balance, ก่อนหน้า = ถอน หรือ ฝาก
    if (nums.length < 2) continue
    const balance    = nums[nums.length - 1]
    const txnAmount  = nums[nums.length - 2]

    // หา memo (ข้อความระหว่าง time กับตัวเลขแรก)
    const timeRe = /\d{2}:\d{2}/
    const timeM  = line.match(timeRe)
    const time   = timeM ? timeM[0] : null
    const memo   = extractMemo(line, timeM ? timeM[0] : m[1])

    // ดูจาก balance เพื่อตัดสิน sign
    const prevRow  = rows[rows.length - 1]
    const prevBal  = prevRow ? prevRow._balance : null
    let amount = txnAmount
    if (prevBal !== null) {
      amount = balance > prevBal ? txnAmount : -txnAmount
    }

    rows.push({ account: 'KBank', date, time, amount, category: '', transferred_account: '', memo, picture_filename: '', _balance: balance })
  }
  return rows
}

// ---- SCB PDF Parser ----
// Format: DD/MM/YYYY  เวลา  รายการ  เดบิต  เครดิต  ยอดคงเหลือ
function parseSCBPDF(lines) {
  const rows = []
  const dateRe = /^(\d{1,2}\/\d{1,2}\/\d{4})/
  for (const line of lines) {
    const m = line.match(dateRe)
    if (!m) continue
    const date  = parseThaiDate(m[1])
    if (!date) continue
    const cleaned = line.replace(/,/g, '')
    const nums = cleaned.match(/\d+\.\d{2}/g)?.map(Number) || []
    if (nums.length < 2) continue
    const balance   = nums[nums.length - 1]
    const txnAmount = nums[nums.length - 2]
    const memo = extractMemo(line, m[1])
    rows.push({ account: 'SCB', date, time: null, amount: txnAmount, category: '', transferred_account: '', memo, picture_filename: '', _balance: balance })
  }
  return rows
}

// ---- KTB PDF Parser ----
function parseKTBPDF(lines) {
  const rows = []
  const dateRe = /^(\d{1,2}\/\d{1,2}\/\d{2,4})/
  for (const line of lines) {
    const m = line.match(dateRe)
    if (!m) continue
    const date = parseDateShortBE(m[1])
    if (!date) continue
    const cleaned = line.replace(/,/g, '')
    const nums = cleaned.match(/\d+\.\d{2}/g)?.map(Number) || []
    if (nums.length < 2) continue
    const balance   = nums[nums.length - 1]
    const txnAmount = nums[nums.length - 2]
    const memo = extractMemo(line, m[1])
    rows.push({ account: 'KTB', date, time: null, amount: txnAmount, category: '', transferred_account: '', memo, picture_filename: '', _balance: balance })
  }
  return rows
}

// ---- Generic Bank PDF Parser (fallback) ----
function parseGenericBankPDF(lines) {
  const rows = []
  const dateRe = /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/
  for (const line of lines) {
    const m = line.match(dateRe)
    if (!m) continue
    const date = parseDateShortBE(m[1].replace(/-/g, '/'))
    if (!date) continue
    const cleaned = line.replace(/,/g, '')
    const nums = cleaned.match(/\d+\.\d{2}/g)?.map(Number) || []
    if (nums.length < 1) continue
    const txnAmount = nums.length >= 2 ? nums[nums.length - 2] : nums[0]
    const memo = extractMemo(line, m[1])
    rows.push({ account: 'Bank', date, time: null, amount: txnAmount, category: '', transferred_account: '', memo, picture_filename: '' })
  }
  return rows
}

// ---- PDF Date helpers ----

function parseDateShortBE(str) {
  // DD/MM/YY (พศ.) → YYYY-MM-DD (คศ.)
  if (!str) return null
  const parts = str.split('/')
  if (parts.length !== 3) return null
  let [d, m, y] = parts.map(Number)
  if (y < 100) {
    // สองหลัก: ถ้า > 43 = พศ. 25xx (2500+y-543)
    y = y > 43 ? 1900 + y + 57 : 2000 + y   // เช่น 67 → 2024, 68 → 2025
  } else if (y > 2400) {
    y = y - 543  // พศ. เต็ม → คศ.
  }
  if (!d || !m || !y) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function extractMemo(line, afterStr) {
  const idx = line.indexOf(afterStr)
  if (idx === -1) return line.substring(0, 50)
  const rest = line.substring(idx + afterStr.length).trim()
  // ตัดตัวเลขและ balance ออก เหลือแต่ข้อความ
  return rest.replace(/[\d,]+\.\d{2}/g, '').replace(/\s+/g, ' ').trim().substring(0, 100)
}

// ================================================================
// PUBLIC: เลือก parser ตาม file type
// ================================================================

async function parseFile(file, accountOverride = '') {
  if (file.name.toLowerCase().endsWith('.pdf')) {
    return parsePDFFile(file, accountOverride)
  }
  return parseCSVFile(file, accountOverride)
}

// ---- CSV Parser + Hash สำหรับ deduplication ----

// รองรับ format หลัก
const CSV_FORMATS = {
  // format ภายในของ HiSolar (export จากแอปเดิม)
  HISOLAR: {
    detect: (headers) => headers.includes('recordno') || headers.includes('account'),
    map: (row) => ({
      account:              row['account']             || row['Account']             || '',
      date:                 parseThaiDate(row['date']  || row['Date']                || ''),
      time:                 row['time']                || row['Time']                || null,
      amount:               parseFloat(row['amount']   || row['Amount']              || 0),
      category:             row['category']            || row['Category']            || '',
      transferred_account:  row['transfered-account']  || row['Transfered-Account']  || '',
      memo:                 row['memo/note']            || row['Memo/Note']           || '',
      picture_filename:     row['picturefilename']      || row['PictureFileName']     || '',
    })
  },

  // KBank CSV statement (ธนาคารกสิกรไทย)
  KBANK: {
    detect: (headers) => headers.some(h => h.includes('txn') || h.includes('withdrawal') || h.includes('deposit')),
    map: (row) => ({
      account:     'KBank',
      date:        parseDateAuto(Object.values(row)[0] || ''),
      time:        null,
      amount:      resolveAmount(row['deposit'] || row['Deposit'] || '', row['withdrawal'] || row['Withdrawal'] || ''),
      category:    '',
      transferred_account: '',
      memo:        row['description'] || row['Description'] || row['channel'] || '',
      picture_filename: '',
    })
  },

  // SCB CSV statement (ไทยพาณิชย์)
  SCB: {
    detect: (headers) => headers.some(h => h.includes('scb') || h.includes('เครดิต') || h.includes('เดบิต')),
    map: (row) => ({
      account:     'SCB',
      date:        parseDateAuto(row['วันที่'] || row['date'] || ''),
      time:        row['เวลา'] || null,
      amount:      resolveAmount(row['เครดิต'] || '', row['เดบิต'] || ''),
      category:    '',
      transferred_account: '',
      memo:        row['รายละเอียด'] || row['description'] || '',
      picture_filename: '',
    })
  }
}

// ---- Public API ----

async function parseCSVFile(file, accountOverride = '') {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        try {
          const rows = await transformRows(result.data, accountOverride)
          resolve(rows)
        } catch (e) {
          reject(e)
        }
      },
      error: reject
    })
  })
}

async function transformRows(rawRows, accountOverride) {
  if (!rawRows.length) return []

  const headers = Object.keys(rawRows[0]).map(h => h.toLowerCase().trim())
  const format = detectFormat(headers)

  const rows = []
  for (const raw of rawRows) {
    // normalize keys
    const normalized = {}
    for (const [k, v] of Object.entries(raw)) {
      normalized[k.toLowerCase().trim()] = (v || '').trim()
    }

    const mapped = format.map(normalized)
    if (!mapped.date || isNaN(mapped.amount)) continue

    if (accountOverride) mapped.account = accountOverride

    mapped.hash = await makeHash(mapped)
    rows.push(mapped)
  }
  return rows
}

function detectFormat(headers) {
  for (const fmt of Object.values(CSV_FORMATS)) {
    if (fmt.detect(headers)) return fmt
  }
  // fallback: HiSolar format
  return CSV_FORMATS.HISOLAR
}

// ---- Hash (SHA-256) สำหรับ dedup ----
async function makeHash(row) {
  const str = [row.account, row.date, row.amount, row.memo].join('|')
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---- Date helpers ----

function parseThaiDate(str) {
  // รองรับ D/M/YYYY หรือ DD/MM/YYYY
  if (!str) return null
  const parts = str.split('/')
  if (parts.length !== 3) return parseDateAuto(str)
  const [d, m, y] = parts.map(Number)
  if (!d || !m || !y) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function parseDateAuto(str) {
  if (!str) return null
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10)
  // DD/MM/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(str)) return parseThaiDate(str)
  // DD-MM-YYYY
  if (/^\d{1,2}-\d{1,2}-\d{4}/.test(str)) return parseThaiDate(str.replace(/-/g, '/'))
  return null
}

function resolveAmount(credit, debit) {
  const c = parseFloat((credit || '').replace(/,/g, '')) || 0
  const d = parseFloat((debit  || '').replace(/,/g, '')) || 0
  if (c > 0) return c
  if (d > 0) return -d
  return 0
}
