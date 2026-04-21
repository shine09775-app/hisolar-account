// ---- Dashboard: Query Supabase + Render ----

let allTransactions = []
let currentRows     = []
let chartIncome, chartExpenseGroup, chartIncomeCustomer

// Maintain lookup maps: key = "YYYY-MM-DD|amount" → full record (fallback)
let incomeMap  = {}   // amount > 0
let expenseMap = {}   // amount (positive value)
// Primary lookup by transaction_id (ไม่ชน key แม้ date+amount เหมือนกัน)
let incomeMapByTxId  = {}
let expenseMapByTxId = {}
let incomeTxKeyCount = {}
let expenseTxKeyCount = {}

// Contacts lookup: account_number/code → { name, type }
let contactMap  = {}
let allContacts = []

// VAT flags: Set of transaction IDs that are marked as VAT
let vatSet = new Set()

// Auto Sync state
let syncResults       = new Map()   // txId → { status, contact?, score? }
let autoSyncAutoItems   = []        // score > 0.8
let autoSyncReviewItems = []        // score 0.5–0.8

const LEGACY_JOINT_ACCOUNT_NAME = 'น.ส. อาภาพร เทพจันทร์ และ นาย วสันต์ ปานแย้ม'
const STANDARD_JOINT_ACCOUNT_NAME = 'บัญชีคู่'

async function initDashboard() {
  await Auth.guard()
  await Promise.all([loadTransactions(), loadMaintainRecords(), loadContactsMap(), loadVatFlags()])
  renderAll(allTransactions)
  setupDashboardActionDelegates()
  setupFilters()
}

// ---- Load contacts from สมุดรายชื่อ & build lookup map ----
async function loadContactsMap() {
  const { data } = await db.from('contacts').select('name, account_number, type, notes')
  allContacts = data || []
  contactMap  = {}
  ;(data || []).forEach(c => {
    if (c.account_number) contactMap[c.account_number] = { name: c.name, type: c.type }
  })
}

function normalizeContactName(value) {
  return String(value || '').trim().toLowerCase()
}

function findContactByName(name, preferredType = '') {
  const normalized = normalizeContactName(name)
  if (!normalized) return null

  const match = (type = '') => allContacts.find(contact => {
    if (type && contact.type !== type) return false
    return normalizeContactName(contact.name) === normalized
  })

  return match(preferredType) || match() || null
}

function getMaintainedInternalContact(t, excludeName = '') {
  const maintainedName = getMaintainedName(t)
  const contact = findContactByName(maintainedName, 'internal')
  if (!contact) return null
  if (excludeName && normalizeContactName(contact.name) === normalizeContactName(excludeName)) return null
  return contact
}

function getMaintainedContactInfo(t) {
  const maintainedName = getMaintainedName(t)
  if (!maintainedName) return null

  const internalContact = findContactByName(maintainedName, 'internal')
  if (internalContact) {
    return { name: internalContact.name, type: 'internal', source: 'maintain' }
  }

  const defaultType = t.amount > 0 ? 'customer' : 'supplier'
  const matched = findContactByName(maintainedName, defaultType)
  if (matched) {
    return { name: matched.name, type: matched.type, source: 'maintain' }
  }

  const manualType = normalizeInternalType(t.category)
  if (INTERNAL_TYPES.has(manualType)) {
    return { name: maintainedName, type: 'internal', source: 'maintain' }
  }

  return { name: maintainedName, type: defaultType, source: 'maintain' }
}

// คืน { name, type } จากสมุดรายชื่อหรือ maintain records
function getContactInfo(t) {
  // Priority 1: maintain records (date+amount exact match)
  const maintained = getMaintainedContactInfo(t)
  if (maintained) return maintained
  // Priority 2: internal transfer detection from source account + memo
  const sourceInternal = findInternalSource(t.account)
  const targetInternal = t.memo ? findInternalCounterparty(t.memo, sourceInternal?.name || '') : null
  if (isRecognizedInternalContact(sourceInternal) && isRecognizedInternalContact(targetInternal)) {
    return { name: targetInternal.name, type: 'internal', source: 'contact' }
  }
  // Priority 2: contacts by account_number appearing in memo
  if (t.memo) {
    for (const [code, contact] of Object.entries(contactMap)) {
      if (code && t.memo.includes(code)) return { name: contact.name, type: contact.type, source: 'contact' }
    }
  }
  return null
}

function getResolvedInternalInfoContact(info, t = null) {
  if (!info || info.type !== 'internal') return null

  const byName = findInternalSource(info.name)
  if (isRecognizedInternalContact(byName)) return byName

  if (t) {
    const sourceInternal = findInternalSource(t.account)
    if (
      isRecognizedInternalContact(sourceInternal) &&
      normalizeContactName(sourceInternal?.name) === normalizeContactName(info.name)
    ) {
      return sourceInternal
    }
  }

  return null
}

function hasRecognizedInternalInfo(info, t = null) {
  return !!getResolvedInternalInfoContact(info, t)
}

// ---- Load VAT flags from transaction_vat table ----
async function loadVatFlags() {
  const { data } = await db.from('transaction_vat').select('transaction_id')
  vatSet = new Set((data || []).map(r => String(r.transaction_id)))
}

function isMissingColumnError(error, columnName) {
  const message = String(error?.message || '').toLowerCase()
  const column  = String(columnName || '').toLowerCase()
  return !!column && message.includes(column) && (
    message.includes('could not find') ||
    message.includes('schema cache') ||
    message.includes('column')
  )
}

async function selectMaintainRows(table, baseColumns, optionalColumns = []) {
  const allColumns = [...baseColumns, ...optionalColumns]
  let { data, error } = await db.from(table).select(allColumns.join(', '))

  if (error && optionalColumns.some(col => isMissingColumnError(error, col))) {
    ;({ data, error } = await db.from(table).select(baseColumns.join(', ')))
  }

  if (error) throw error
  return data || []
}

async function upsertMaintainRecord(table, payload, existingId = null) {
  let nextPayload = { ...payload }

  const doQuery = (id) => id
    ? db.from(table).update(nextPayload).eq('id', id).select()
    : db.from(table).insert(nextPayload).select()

  let result = await doQuery(existingId)

  if (result.error && Object.prototype.hasOwnProperty.call(nextPayload, 'transaction_id') && isMissingColumnError(result.error, 'transaction_id')) {
    delete nextPayload.transaction_id
    result = await doQuery(existingId)
  }

  if (result.error) throw result.error

  if (!result.data || result.data.length === 0) {
    throw new Error(
      existingId
        ? `ไม่สามารถอัปเดตตาราง ${table} ได้ — ตรวจสอบ Supabase RLS Policy (UPDATE permission)`
        : `ไม่สามารถบันทึกลงตาราง ${table} ได้ — ตรวจสอบ Supabase RLS Policy (INSERT permission)`
    )
  }
}

// ---- Load maintain records & build lookup maps ----
async function loadMaintainRecords() {
  let inc = []
  let exp = []
  try {
    [inc, exp] = await Promise.all([
      selectMaintainRows(
        'income_records',
        ['id', 'transaction_date', 'amount', 'customer_name', 'job_name', 'job_details', 'account_number', 'file_url', 'file_name'],
        ['transaction_id']
      ),
      selectMaintainRows(
        'expense_records',
        ['id', 'transaction_date', 'amount', 'supplier_name', 'details', 'account_number', 'file_url', 'file_name'],
        ['transaction_id']
      ),
    ])
  } catch (error) {
    console.error('loadMaintainRecords failed:', error)
  }

  incomeMap = {}; incomeMapByTxId = {}
  ;(inc || []).forEach(r => {
    if (r.transaction_date && r.amount != null) {
      const key = `${r.transaction_date}|${r.amount}`
      ;(incomeMap[key] ||= []).push(r)
    }
    if (r.transaction_id) incomeMapByTxId[String(r.transaction_id)] = r
  })
  expenseMap = {}; expenseMapByTxId = {}
  ;(exp || []).forEach(r => {
    if (r.transaction_date && r.amount != null) {
      const key = `${r.transaction_date}|${r.amount}`
      ;(expenseMap[key] ||= []).push(r)
    }
    if (r.transaction_id) expenseMapByTxId[String(r.transaction_id)] = r
  })
}

function getUniqueMaintainFallback(map, txKeyCount, key) {
  const records = map[key] || []
  if (records.length !== 1) return null
  if ((txKeyCount[key] || 0) !== 1) return null
  return records[0]
}

// คืน maintain record สำหรับ transaction นั้น — ค้นด้วย txId ก่อน
// fallback date|amount ใช้เฉพาะกรณีที่ key นั้น unique จริงทั้งฝั่ง transaction และ maintain
function getMaintainRecord(t) {
  const txId = String(t.id)
  if (t.amount > 0) {
    return incomeMapByTxId[txId] ||
      getUniqueMaintainFallback(incomeMap, incomeTxKeyCount, `${t.date}|${t.amount}`) ||
      null
  }
  if (t.amount < 0) {
    return expenseMapByTxId[txId] ||
      getUniqueMaintainFallback(expenseMap, expenseTxKeyCount, `${t.date}|${Math.abs(t.amount)}`) ||
      null
  }
  return null
}

function getMaintainedName(t) {
  const r = getMaintainRecord(t)
  return t.amount > 0 ? (r?.customer_name || null) : (r?.supplier_name || null)
}

function getMaintainedDetail(t) {
  const r = getMaintainRecord(t)
  return t.amount > 0 ? (r?.job_name || null) : (r?.details || null)
}

// ---- Load from Supabase (date / search — account+category กรองฝั่ง client) ----
async function loadTransactions(filters = {}) {
  let query = db.from('transactions').select('*').order('date', { ascending: false })
  if (filters.dateFrom) query = query.gte('date', filters.dateFrom)
  if (filters.dateTo)   query = query.lte('date', filters.dateTo)
  if (filters.search)   query = query.ilike('memo', `%${filters.search}%`)

  const { data, error } = await query.limit(2000)
  if (error) { console.error(error); return }
  allTransactions = data || []
  incomeTxKeyCount = {}
  expenseTxKeyCount = {}
  for (const t of allTransactions) {
    if (!t?.date || !Number.isFinite(Number(t.amount)) || Number(t.amount) === 0) continue
    const key = t.amount > 0
      ? `${t.date}|${t.amount}`
      : `${t.date}|${Math.abs(t.amount)}`
    const target = t.amount > 0 ? incomeTxKeyCount : expenseTxKeyCount
    target[key] = (target[key] || 0) + 1
  }
}

// ---- Client-side filters: account + contactType + contactName ----
function applyClientFilter(rows, { account = '', contactType = '', contactName = '' } = {}) {
  let result = rows
  if (account) result = result.filter(t => displayAccount(t.account) === account)
  if (contactType === 'customer') result = result.filter(t => t.amount > 0)
  else if (contactType === 'supplier') result = result.filter(t => t.amount < 0)
  if (contactName) {
    result = result.filter(t => {
      const info = getContactInfo(t)
      return info && info.name === contactName
    })
  }
  return result
}

// ---- Render ทุก section พร้อมกัน ----
function renderAll(rows) {
  currentRows = rows
  renderSummaryCards(rows)
  renderIncomeChart(rows)
  renderMonthlyTable(rows)
  renderExpenseGroupChart(rows)
  renderIncomeCustomerChart(rows)
  renderTable(rows)
  if (!document.getElementById('vat-panel')?.classList.contains('hidden')) {
    renderVatTab(rows)
  }
}

// ---- Summary Cards ----
function renderSummaryCards(rows) {
  const { excludedIds, dividendIds } = buildMonthlyInternalSummary(rows)
  const visibleRows = rows.filter(t => !excludedIds.has(String(t.id)))
  const income = visibleRows
    .filter(t => t.amount > 0 && !dividendIds.has(String(t.id)))
    .reduce((s, t) => s + t.amount, 0)
  const expense = visibleRows
    .filter(t => t.amount < 0 && !dividendIds.has(String(t.id)))
    .reduce((s, t) => s + Math.abs(t.amount), 0)
  const dividend = visibleRows
    .filter(t => dividendIds.has(String(t.id)))
    .reduce((s, t) => s + Math.abs(t.amount), 0)
  const totalExpense = expense + dividend
  const balance = income - totalExpense
  setText('card-income',  formatBaht(income))
  setText('card-expense', formatBaht(totalExpense))
  setText('card-balance', formatBaht(balance))
  setText('card-count',   visibleRows.length.toLocaleString('th-TH'))
  const balEl = document.getElementById('card-balance')
  if (balEl) balEl.className = balance >= 0
    ? 'text-2xl font-bold text-green-600'
    : 'text-2xl font-bold text-red-600'
}

// ---- Monthly Income/Expense Bar Chart ----
function buildMonthlyInternalSummary(rows) {
  const { transferItems, outToDir, inFromDir, advanceClears, dividends, salaries, others } = detectInternalTx(rows)
  const excludedIds = new Set()
  const dividendIds = new Set(dividends.map(({ t }) => String(t.id)))

  for (const tx of transferItems) excludedIds.add(String(tx.id))
  for (const { t } of outToDir) excludedIds.add(String(t.id))
  for (const { t } of inFromDir) excludedIds.add(String(t.id))
  for (const { t } of advanceClears) excludedIds.add(String(t.id))
  for (const { t } of salaries) excludedIds.add(String(t.id))
  for (const { t } of others) excludedIds.add(String(t.id))

  return { excludedIds, dividendIds }
}

function renderIncomeChart(rows) {
  const monthly = {}
  const { excludedIds, dividendIds } = buildMonthlyInternalSummary(rows)

  for (const t of rows) {
    const ym = t.date?.substring(0, 7)
    if (!ym) continue

    const txId = String(t.id)
    if (!monthly[ym]) monthly[ym] = { income: 0, expense: 0, dividend: 0 }

    if (dividendIds.has(txId)) {
      monthly[ym].dividend += Math.abs(t.amount)
      continue
    }
    if (excludedIds.has(txId)) continue

    if (t.amount > 0) monthly[ym].income += t.amount
    else monthly[ym].expense += Math.abs(t.amount)
  }

  const labels     = Object.keys(monthly).sort()
  const income     = labels.map(l => monthly[l].income)
  const expense    = labels.map(l => monthly[l].expense)
  const dividend   = labels.map(l => monthly[l].dividend)

  const ctx = document.getElementById('chart-monthly')?.getContext('2d')
  if (!ctx) return
  if (chartIncome) chartIncome.destroy()
  chartIncome = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.map(formatYM),
      datasets: [
        { type: 'bar', label: 'รายรับ', data: income, backgroundColor: '#22c55e', stack: 'income' },
        { type: 'bar', label: 'รายจ่าย', data: expense, backgroundColor: '#ef4444', stack: 'expense' },
        { type: 'bar', label: 'เงินปันผล', data: dividend, backgroundColor: '#2563eb', stack: 'expense' },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top' } },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true },
        y: { stacked: true, ticks: { callback: v => '฿' + v.toLocaleString('th-TH') } },
      },
    },
  })
}
// ---- Monthly Summary Table ----
function renderMonthlyTable(rows) {
  const el = document.getElementById('monthly-summary-table')
  if (!el) return

  const monthly = {}
  const { excludedIds, dividendIds } = buildMonthlyInternalSummary(rows)

  for (const t of rows) {
    const ym = t.date?.substring(0, 7)
    if (!ym) continue

    const txId = String(t.id)
    if (dividendIds.has(txId)) {
      if (!monthly[ym]) monthly[ym] = { income: 0, expense: 0, dividend: 0 }
      monthly[ym].dividend += Math.abs(t.amount)
      continue
    }
    if (excludedIds.has(txId)) continue

    if (!monthly[ym]) monthly[ym] = { income: 0, expense: 0, dividend: 0 }
    if (t.amount > 0) monthly[ym].income += t.amount
    else monthly[ym].expense += Math.abs(t.amount)
  }

  const labels = Object.keys(monthly).sort()
  if (!labels.length) { el.innerHTML = ''; return }

  const totalIncome   = labels.reduce((s, l) => s + monthly[l].income, 0)
  const totalExpense  = labels.reduce((s, l) => s + monthly[l].expense, 0)
  const totalDividend = labels.reduce((s, l) => s + monthly[l].dividend, 0)
  const totalNet      = totalIncome - totalExpense - totalDividend

  const netClass = (n) => n >= 0 ? 'text-blue-600 font-bold' : 'text-red-600 font-bold'

  const rowsHtml = labels.map(ym => {
    const { income, expense, dividend } = monthly[ym]
    const net = income - expense - dividend
    return `<tr class="border-t border-gray-100 hover:bg-gray-50">
      <td class="px-4 py-2.5 text-sm text-gray-700 font-medium">${formatYM(ym)}</td>
      <td class="px-4 py-2.5 text-sm text-green-600 font-semibold text-right">${formatBaht(income)}</td>
      <td class="px-4 py-2.5 text-sm text-orange-500 font-semibold text-right">${formatBaht(expense)}</td>
      <td class="px-4 py-2.5 text-sm text-blue-600 font-semibold text-right">${formatBaht(dividend)}</td>
      <td class="px-4 py-2.5 text-sm text-right ${netClass(net)}">${formatBaht(net)}</td>
    </tr>`
  }).join('')

  el.innerHTML = `
    <div class="overflow-x-auto mt-4 rounded-xl border border-gray-200">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="bg-slate-700 text-white">
            <th class="px-4 py-3 text-left font-semibold">เดือน</th>
            <th class="px-4 py-3 text-right font-semibold">รายรับ (บาท)</th>
            <th class="px-4 py-3 text-right font-semibold">รายจ่าย (บาท)</th>
            <th class="px-4 py-3 text-right font-semibold">ปันผล (บาท)</th>
            <th class="px-4 py-3 text-right font-semibold">สุทธิ</th>
          </tr>
        </thead>
        <tbody class="bg-white">
          ${rowsHtml}
          <tr class="border-t-2 border-gray-300 bg-gray-50">
            <td class="px-4 py-3 text-sm font-bold text-gray-800">รวม</td>
            <td class="px-4 py-3 text-sm font-bold text-green-600 text-right">${formatBaht(totalIncome)}</td>
            <td class="px-4 py-3 text-sm font-bold text-orange-500 text-right">${formatBaht(totalExpense)}</td>
            <td class="px-4 py-3 text-sm font-bold text-blue-600 text-right">${formatBaht(totalDividend)}</td>
            <td class="px-4 py-3 text-sm text-right ${netClass(totalNet)}">${formatBaht(totalNet)}</td>
          </tr>
        </tbody>
      </table>
    </div>`
}
// ---- Expense by Supplier Group (Pie) ----
function renderExpenseGroupChart(rows) {
  const ctx = document.getElementById('chart-expense-group')?.getContext('2d')
  if (!ctx) return

  const { excludedIds, dividendIds } = buildMonthlyInternalSummary(rows)
  const groups = {}
  for (const t of rows.filter(t => t.amount < 0)) {
    if (excludedIds.has(String(t.id)) || dividendIds.has(String(t.id))) continue
    const info = getContactInfo(t)
    if (hasRecognizedInternalInfo(info, t)) continue
    const grp = (info && info.type === 'supplier') ? info.name : resolveCategory(t.memo)
    groups[grp] = (groups[grp] || 0) + Math.abs(t.amount)
  }
  const sorted = Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 10)
  const labels = sorted.map(e => e[0])
  const values = sorted.map(e => e[1])
  const total  = values.reduce((a, b) => a + b, 0)

  const colorMap = Object.fromEntries(CATEGORY_MAP.map(c => [c.group, c.color]))
  const colors   = labels.map(l => colorMap[l] || '#94a3b8')

  if (chartExpenseGroup) chartExpenseGroup.destroy()
  chartExpenseGroup = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 10, padding: 5 } },
        tooltip: {
          callbacks: {
            label: c => ` ${formatBaht(c.raw)}  (${total ? Math.round(c.raw / total * 100) : 0}%)`
          }
        }
      }
    }
  })
}
// ---- Income by Customer (Pie) ----
function renderIncomeCustomerChart(rows) {
  const ctx = document.getElementById('chart-income-customer')?.getContext('2d')
  if (!ctx) return

  const { excludedIds, dividendIds } = buildMonthlyInternalSummary(rows)
  const customers = {}
  for (const t of rows.filter(t => t.amount > 0)) {
    if (excludedIds.has(String(t.id)) || dividendIds.has(String(t.id))) continue
    const info = getContactInfo(t)
    if (hasRecognizedInternalInfo(info, t)) continue
    const name = info ? info.name : extractCounterparty(t.memo)
    if (name && name !== '—') customers[name] = (customers[name] || 0) + t.amount
  }
  const sorted = Object.entries(customers).sort((a, b) => b[1] - a[1])
  const top    = sorted.slice(0, 8)
  const others = sorted.slice(8).reduce((s, [, v]) => s + v, 0)
  if (others > 0) top.push(['อื่นๆ', others])

  const labels = top.map(e => e[0])
  const values = top.map(e => e[1])
  const total  = values.reduce((a, b) => a + b, 0)
  const colors = ['#6366f1','#22c55e','#f59e0b','#3b82f6','#ec4899','#14b8a6','#8b5cf6','#f97316','#64748b']

  if (chartIncomeCustomer) chartIncomeCustomer.destroy()
  chartIncomeCustomer = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 10, padding: 5 } },
        tooltip: {
          callbacks: {
            label: c => ` ${formatBaht(c.raw)}  (${total ? Math.round(c.raw / total * 100) : 0}%)`
          }
        }
      }
    }
  })
}
// ---- Transaction Table ----
function renderTable(rows) {
  const tbody = document.getElementById('tx-tbody')
  if (!tbody) return

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-gray-400">ไม่พบข้อมูล</td></tr>'
    return
  }

  tbody.innerHTML = rows.slice(0, 500).map(t => {
    const info         = getContactInfo(t)
    const isRecognizedInternal = hasRecognizedInternalInfo(info, t)
    const counterparty = info ? info.name : extractCounterparty(t.memo)
    const internalType = normalizeInternalType(t.category)
    const savedInternalType = INTERNAL_TYPES.has(internalType) ? internalType : ''
    const syncResult   = syncResults.get(String(t.id))
    const syncTitle    = syncResult?.reason
      ? `${Math.round((syncResult.score || 0) * 100)}% — ${esc(syncResult.reason)}`
      : `${Math.round((syncResult?.score || 0) * 100)}% match`
    const badge = isRecognizedInternal
      ? `<span class="ml-1.5 text-[10px] bg-slate-100 text-slate-500 rounded px-1 py-0.5 font-medium align-middle">ภายใน</span>`
      : info?.source === 'maintain'
        ? `<span class="ml-1.5 text-[10px] bg-indigo-100 text-indigo-500 rounded px-1 py-0.5 font-medium align-middle">M</span>`
        : info?.source === 'contact'
          ? `<span class="ml-1.5 text-[10px] bg-green-100 text-green-600 rounded px-1 py-0.5 font-medium align-middle">สมุด</span>`
          : syncResult?.status === 'auto'
            ? `<span class="ml-1.5 text-[10px] bg-blue-100 text-blue-600 rounded px-1 py-0.5 font-medium align-middle" title="${syncTitle}">⚡${Math.round((syncResult.score||0)*100)}%</span>`
            : syncResult?.status === 'review'
              ? `<span class="ml-1.5 text-[10px] bg-amber-100 text-amber-700 rounded px-1 py-0.5 font-medium align-middle" title="${syncTitle}">⚠${Math.round((syncResult.score||0)*100)}%</span>`
            : syncResult?.status === 'unmatched'
                ? `<span class="ml-1.5 text-[10px] bg-red-100 text-red-500 rounded px-1 py-0.5 font-medium align-middle">❌ ไม่พบ</span>`
                : ''
    const categoryBadge = savedInternalType
      ? `<span class="ml-1.5 text-[10px] bg-emerald-100 text-emerald-700 rounded px-1 py-0.5 font-medium align-middle" title="บันทึกประเภทภายในแล้ว">${esc(savedInternalType)}</span>`
      : ''
    const nameCell = info
      ? `<span class="text-indigo-700 font-semibold">${esc(counterparty)}</span>${badge}${categoryBadge}`
      : (syncResult?.status === 'auto' || syncResult?.status === 'review')
        ? `<span class="text-blue-600 font-medium">${esc(syncResult.contact.name)}</span>${badge}${categoryBadge}`
        : `<span>${esc(counterparty)}</span>${badge}${categoryBadge}`

    const linkBtn = `<button type="button" data-action="open-link" data-tx-id="${esc(String(t.id))}" title="เชื่อมโยง / แก้ไขรายละเอียด"
          class="ml-1.5 text-[10px] bg-yellow-50 text-yellow-600 border border-yellow-200 rounded px-1 py-0.5 hover:bg-yellow-100 transition-colors align-middle whitespace-nowrap">✎ เชื่อม</button>`

    const hasMatch = info?.source === 'maintain' || !!savedInternalType || syncResult?.status === 'auto' || syncResult?.status === 'review'
    const resetBtn = hasMatch
      ? `<button type="button" data-action="reset-match" data-tx-id="${esc(String(t.id))}" title="รีเซ็ตการจับคู่ เพื่อ Match ใหม่"
          class="ml-1 text-[10px] bg-red-50 text-red-400 border border-red-200 rounded px-1 py-0.5 hover:bg-red-100 transition-colors align-middle whitespace-nowrap">↺ รีเซ็ต</button>`
      : ''

    const maintainDetail = getMaintainedDetail(t)
    const detailTitle = esc(maintainDetail || t.memo || '')
    const detailCell  = maintainDetail
      ? `<span class="text-gray-700">${esc(maintainDetail)}</span>`
      : `<span class="text-gray-400 text-xs">${esc(t.memo || '—')}</span>`

    // VAT checkbox
    const isCompanyAcc = displayAccount(t.account) === 'บัญชีบริษัท'
    const canVat       = t.amount < 0 || (t.amount > 0 && isCompanyAcc)
    const isVat        = vatSet.has(String(t.id))
    let vatCell
    if (isRecognizedInternal) {
      vatCell = `<span class="text-gray-200 text-xs">—</span>`
    } else if (canVat) {
      const label = t.amount > 0 ? 'ภาษีขาย' : 'ภาษีซื้อ'
      vatCell = `<label class="flex flex-col items-center gap-0.5 cursor-pointer select-none" title="${label}">
        <input type="checkbox" ${isVat ? 'checked' : ''} data-action="toggle-vat" data-tx-id="${esc(String(t.id))}"
          class="w-4 h-4 rounded accent-yellow-500 cursor-pointer">
        <span class="text-[9px] ${isVat ? 'text-yellow-600 font-semibold' : 'text-gray-300'}">${label}</span>
      </label>`
    } else {
      vatCell = `<span class="text-[9px] text-gray-300 leading-tight text-center block">บัญชีบริษัท<br>เท่านั้น</span>`
    }

    const income  = t.amount > 0
      ? `<span class="text-green-600 font-semibold">${formatBaht(t.amount)}</span>` : ''
    const expense = t.amount < 0
      ? `<span class="text-red-500 font-semibold">${formatBaht(Math.abs(t.amount))}</span>` : ''
    return `<tr class="border-t border-gray-100 hover:bg-gray-50 transition-colors">
      <td class="px-4 py-2 text-sm text-gray-600 whitespace-nowrap">${formatDate(t.date)}</td>
      <td class="px-4 py-2 text-sm text-gray-700">${displayAccount(t.account)}</td>
      <td class="px-4 py-2 text-sm max-w-[220px]" title="${esc(counterparty)}">${nameCell}${linkBtn}${resetBtn}</td>
      <td class="px-4 py-2 text-sm max-w-xs truncate" title="${detailTitle}">${detailCell}</td>
      <td class="px-4 py-2 text-center whitespace-nowrap">${vatCell}</td>
      <td class="px-4 py-2 text-sm text-right whitespace-nowrap">${income}</td>
      <td class="px-4 py-2 text-sm text-right whitespace-nowrap">${expense}</td>
    </tr>`
  }).join('')
}

let dashboardActionDelegatesReady = false

function setupDashboardActionDelegates() {
  if (dashboardActionDelegatesReady) return
  dashboardActionDelegatesReady = true

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]')
    if (!trigger) return

    const action = trigger.dataset.action
    const txId = trigger.dataset.txId

    if (action === 'open-link' && txId) {
      event.preventDefault()
      openLinkModal(txId)
      return
    }

    if (action === 'reset-match' && txId) {
      event.preventDefault()
      resetMatch(txId)
      return
    }
  })

  document.addEventListener('change', (event) => {
    const trigger = event.target.closest('[data-action="toggle-vat"]')
    if (!trigger) return
    const txId = trigger.dataset.txId
    if (!txId) return
    toggleVat(txId)
  })
}

// ---- Filters ----
function populateContactNameDropdown(type = '') {
  const filtered = type ? allContacts.filter(c => c.type === type) : allContacts
  const names    = [...new Set(filtered.map(c => c.name))].sort()
  populateSelect('filter-contact-name', names)
}

function getActiveDashboardFilters() {
  const form = document.getElementById('filter-form')
  const f = form ? new FormData(form) : new FormData()
  return {
    dateFrom: String(f.get('date-from') || ''),
    dateTo: String(f.get('date-to') || ''),
    search: String(f.get('search') || ''),
    account: String(f.get('account') || ''),
    contactType: String(f.get('contact-type') || ''),
    contactName: String(f.get('contact-name') || ''),
  }
}

async function reloadDashboardView(filters = getActiveDashboardFilters()) {
  await Promise.all([
    loadTransactions({
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      search: filters.search,
    }),
    loadMaintainRecords(),
    loadContactsMap(),
    loadVatFlags(),
  ])

  populateContactNameDropdown(filters.contactType)

  const rows = applyClientFilter(allTransactions, {
    account: filters.account,
    contactType: filters.contactType,
    contactName: filters.contactName,
  })
  renderAll(rows)
  setText('tx-count', `แสดง ${Math.min(rows.length, 500)} จาก ${rows.length} รายการ`)
}

function setupFilters() {
  populateSelect('filter-account', ACCOUNT_LABELS.map(l => l.display))
  populateContactNameDropdown()

  // ประเภท filter เปลี่ยน → อัปเดต dropdown รายชื่อ
  document.getElementById('filter-contact-type')?.addEventListener('change', e => {
    populateContactNameDropdown(e.target.value)
    document.getElementById('filter-contact-name').value = ''
  })

  document.getElementById('filter-form')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    await reloadDashboardView(getActiveDashboardFilters())
  })

  document.getElementById('filter-reset')?.addEventListener('click', async () => {
    document.getElementById('filter-form')?.reset()
    populateContactNameDropdown()
    await reloadDashboardView()
  })
}

function chunkArray(items, size = 100) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

async function deleteRowsByIds(table, ids, column = 'id') {
  const uniqueIds = [...new Set((ids || []).filter(Boolean).map(id => String(id)))]
  if (!uniqueIds.length) return { found: 0, deleted: 0, error: null }

  let deleted = 0
  let lastError = null
  for (const chunk of chunkArray(uniqueIds, 100)) {
    const { data, error } = await db.from(table).delete().in(column, chunk).select(column)
    if (error) {
      lastError = error
      continue
    }
    deleted += data?.length || 0
  }

  return { found: uniqueIds.length, deleted, error: lastError }
}

function buildDeleteSummaryLine(label, result) {
  const found = result?.found || 0
  const deleted = result?.deleted || 0
  if (result?.error) {
    return `- ${label}: ดำเนินการได้ ${deleted}/${found} (${result.error.message})`
  }
  return `- ${label}: ดำเนินการได้ ${deleted}/${found}`
}

function normalizeJointAccountName(value) {
  const raw = String(value || '').trim()
  return raw === LEGACY_JOINT_ACCOUNT_NAME || raw === STANDARD_JOINT_ACCOUNT_NAME
    ? STANDARD_JOINT_ACCOUNT_NAME
    : raw
}

function buildJointTransactionDuplicateScan(rows = []) {
  const relevantRows = rows.filter(t => normalizeJointAccountName(t.account) === STANDARD_JOINT_ACCOUNT_NAME)
  const grouped = new Map()

  for (const row of relevantRows) {
    const key = [
      normalizeJointAccountName(row.account),
      row.date || '',
      Number(row.amount || 0).toFixed(2),
      String(row.memo || '').trim().replace(/\s+/g, ' '),
    ].join('|')
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(row)
  }

  const duplicateGroups = []
  const duplicateIds = []

  for (const rowsInGroup of grouped.values()) {
    if (rowsInGroup.length < 2) continue

    const sorted = [...rowsInGroup].sort((a, b) => {
      const aScore = a.account === STANDARD_JOINT_ACCOUNT_NAME ? 1 : 0
      const bScore = b.account === STANDARD_JOINT_ACCOUNT_NAME ? 1 : 0
      if (aScore !== bScore) return bScore - aScore
      return String(a.id).localeCompare(String(b.id))
    })

    const keep = sorted[0]
    const remove = sorted.slice(1)
    duplicateGroups.push({ keep, remove, count: sorted.length })
    duplicateIds.push(...remove.map(row => row.id))
  }

  return { duplicateGroups, duplicateIds }
}

function buildDuplicatePreviewLines(groups = [], limit = 5) {
  return groups.slice(0, limit).map(group => {
    const memo = String(group.keep.memo || '').trim().replace(/\s+/g, ' ').slice(0, 50) || '-'
    return `- ${formatDate(group.keep.date)} | ${formatBaht(Math.abs(group.keep.amount))} | ${memo} (${group.count} แถว)`
  })
}

async function reviewDuplicateTransactions() {
  const btn = document.getElementById('delete-joint-account-btn')

  if (btn) {
    btn.disabled = true
    btn.textContent = 'กำลังตรวจสอบ...'
  }

  try {
    if (!allTransactions.length) {
      await loadTransactions()
    }

    const { duplicateGroups, duplicateIds } = buildJointTransactionDuplicateScan(allTransactions)

    const [
      txResponse,
      uploadLogResponse,
      incomeResponse,
      expenseResponse,
    ] = await Promise.all([
      db.from('transactions').select('id').eq('account', LEGACY_JOINT_ACCOUNT_NAME),
      db.from('upload_logs').select('id').eq('account', LEGACY_JOINT_ACCOUNT_NAME),
      db.from('income_records').select('id').eq('customer_name', LEGACY_JOINT_ACCOUNT_NAME),
      db.from('expense_records').select('id').eq('supplier_name', LEGACY_JOINT_ACCOUNT_NAME),
    ])

    if (txResponse.error) throw txResponse.error
    if (uploadLogResponse.error) throw uploadLogResponse.error
    if (incomeResponse.error) throw incomeResponse.error
    if (expenseResponse.error) throw expenseResponse.error

    const legacyTxCount = txResponse.data?.length || 0
    const duplicateTxCount = duplicateIds.length

    if (!legacyTxCount && !duplicateTxCount) {
      alert(`ไม่พบรายการชื่อเก่าหรือรายการซ้ำของ "${STANDARD_JOINT_ACCOUNT_NAME}"`)
      return
    }

    const previewLines = buildDuplicatePreviewLines(duplicateGroups)
    const confirmText = [
      `ตรวจพบรายการที่ควรยุบรวมสำหรับ "${STANDARD_JOINT_ACCOUNT_NAME}"`,
      '',
      `- ชื่อเก่า "${LEGACY_JOINT_ACCOUNT_NAME}" ใน transactions: ${legacyTxCount} แถว`,
      `- duplicate groups ใน transactions: ${duplicateGroups.length} กลุ่ม`,
      `- transaction แถวซ้ำที่เตรียมลบ: ${duplicateTxCount} แถว`,
      `- upload_logs ชื่อเก่า: ${uploadLogResponse.data?.length || 0} แถว`,
      `- income_records ชื่อเก่า: ${incomeResponse.data?.length || 0} แถว`,
      `- expense_records ชื่อเก่า: ${expenseResponse.data?.length || 0} แถว`,
      '',
      'เกณฑ์ตรวจซ้ำ: บัญชี(หลัง normalize เป็น "บัญชีคู่") + วันที่ + จำนวน + memo ตรงกัน',
      previewLines.length ? '' : null,
      previewLines.length ? 'ตัวอย่างรายการซ้ำ:' : null,
      ...previewLines,
      '',
      'ยืนยันเพื่อยุบรวมชื่อเก่าและลบ transaction ซ้ำที่ตรวจพบหรือไม่?',
    ].filter(Boolean).join('\n')

    if (!confirm(confirmText)) return

    if (btn) {
      btn.textContent = 'กำลังยุบรวม...'
    }

    const transactionUpdate = await db.from('transactions')
      .update({ account: STANDARD_JOINT_ACCOUNT_NAME })
      .eq('account', LEGACY_JOINT_ACCOUNT_NAME)
      .select('id')
    const transactionResult = {
      found: txResponse.data?.length || 0,
      deleted: transactionUpdate.data?.length || 0,
      error: transactionUpdate.error || null,
    }

    const uploadLogUpdate = await db.from('upload_logs')
      .update({ account: STANDARD_JOINT_ACCOUNT_NAME })
      .eq('account', LEGACY_JOINT_ACCOUNT_NAME)
      .select('id')
    const uploadLogResult = {
      found: uploadLogResponse.data?.length || 0,
      deleted: uploadLogUpdate.data?.length || 0,
      error: uploadLogUpdate.error || null,
    }

    const incomeUpdate = await db.from('income_records')
      .update({ customer_name: STANDARD_JOINT_ACCOUNT_NAME })
      .eq('customer_name', LEGACY_JOINT_ACCOUNT_NAME)
      .select('id')
    const incomeResult = {
      found: incomeResponse.data?.length || 0,
      deleted: incomeUpdate.data?.length || 0,
      error: incomeUpdate.error || null,
    }

    const expenseUpdate = await db.from('expense_records')
      .update({ supplier_name: STANDARD_JOINT_ACCOUNT_NAME })
      .eq('supplier_name', LEGACY_JOINT_ACCOUNT_NAME)
      .select('id')
    const expenseResult = {
      found: expenseResponse.data?.length || 0,
      deleted: expenseUpdate.data?.length || 0,
      error: expenseUpdate.error || null,
    }

    const duplicateDelete = await deleteRowsByIds('transactions', duplicateIds)

    const contactDelete = await db.from('contacts')
      .delete()
      .eq('name', LEGACY_JOINT_ACCOUNT_NAME)
      .select('id')
    const contactResult = {
      found: contactDelete.data?.length || 0,
      deleted: contactDelete.data?.length || 0,
      error: contactDelete.error || null,
    }

    await Promise.all([loadTransactions(), loadMaintainRecords(), loadContactsMap(), loadVatFlags()])
    syncResults = new Map()
    autoSyncAutoItems = []
    autoSyncReviewItems = []
    currentRows = allTransactions
    renderAll(allTransactions)
    const dates = allTransactions.map(t => t.date).filter(Boolean).sort()
    if (dates.length) {
      setText('data-range', `ข้อมูล ${formatDate(dates[0])} — ${formatDate(dates[dates.length - 1])}`)
    } else {
      setText('data-range', 'ยังไม่มีข้อมูล — กรุณา Upload Statement ก่อน')
    }
    populateContactNameDropdown()
    setText('tx-count', `แสดง ${Math.min(allTransactions.length, 500)} จาก ${allTransactions.length} รายการ`)

    const summary = [
      `ผลการรวมชื่อบัญชี "${LEGACY_JOINT_ACCOUNT_NAME}" → "${STANDARD_JOINT_ACCOUNT_NAME}"`,
      buildDeleteSummaryLine('transactions', transactionResult),
      buildDeleteSummaryLine('upload_logs', uploadLogResult),
      buildDeleteSummaryLine('income_records', incomeResult),
      buildDeleteSummaryLine('expense_records', expenseResult),
      buildDeleteSummaryLine('transactions ซ้ำ (ลบ)', duplicateDelete),
      buildDeleteSummaryLine('contacts (ลบชื่อเก่า)', contactResult),
    ].join('\n')

    alert(summary)
    showSyncToast(
      transactionResult.error || uploadLogResult.error || incomeResult.error || expenseResult.error || duplicateDelete.error
        ? 'ยุบรวมรายการซ้ำได้บางส่วน'
        : 'ยุบรวมรายการซ้ำสำเร็จ',
      transactionResult.error || uploadLogResult.error || incomeResult.error || expenseResult.error || duplicateDelete.error ? 'red' : 'green'
    )
  } catch (err) {
    alert('ตรวจสอบ/ยุบรวมรายการซ้ำไม่สำเร็จ: ' + err.message)
    showSyncToast('ตรวจสอบ/ยุบรวมรายการซ้ำไม่สำเร็จ', 'red')
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = 'ตรวจสอบรายการซ้ำ'
    }
  }
}

// ---- VAT Toggle ----
async function toggleVat(txId) {
  const id = String(txId)
  try {
    if (vatSet.has(id)) {
      const { error } = await db.from('transaction_vat').delete().eq('transaction_id', id)
      if (error) throw error
      vatSet.delete(id)
    } else {
      const { error } = await db.from('transaction_vat').insert({ transaction_id: id })
      if (error) throw error
      vatSet.add(id)
    }
    renderTable(currentRows)
    if (!document.getElementById('vat-panel')?.classList.contains('hidden')) {
      renderVatTab(currentRows)
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message)
    renderTable(currentRows)  // revert checkbox state
  }
}

// ---- VAT Report Tab ----
function switchMonthlyTab(tab) {
  const isVat = tab === 'vat'
  document.getElementById('monthly-panel').classList.toggle('hidden', isVat)
  document.getElementById('vat-panel').classList.toggle('hidden', !isVat)
  const activeClass   = 'px-3 py-1.5 rounded-lg font-semibold bg-yellow-400 text-white transition-colors text-xs'
  const inactiveClass = 'px-3 py-1.5 rounded-lg font-semibold bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors text-xs'
  document.getElementById('subtab-monthly').className = isVat ? inactiveClass : activeClass
  document.getElementById('subtab-vat').className     = isVat ? activeClass   : inactiveClass
  if (isVat) renderVatTab(currentRows)
}

function renderVatTab(rows) {
  const el = document.getElementById('vat-summary-table')
  if (!el) return

  const vatTx = rows.filter(t => vatSet.has(String(t.id)) && t.amount !== 0)

  if (!vatTx.length) {
    el.innerHTML = '<p class="text-center py-10 text-gray-400 text-sm">ยังไม่มีรายการที่ติ๊ก VAT ในช่วงเวลานี้<br><span class="text-xs text-gray-300">ติ๊ก checkbox คอลัมน์ VAT ที่ตารางรายการธุรกรรมด้านล่าง</span></p>'
    return
  }

  const monthly = {}
  for (const t of vatTx) {
    const ym = t.date?.substring(0, 7)
    if (!ym) continue
    if (!monthly[ym]) monthly[ym] = { outBase: 0, outVat: 0, inBase: 0, inVat: 0 }
    const gross = Math.abs(t.amount)
    const base  = gross / 1.07
    const vat   = gross - base
    if (t.amount > 0) { monthly[ym].outBase += base; monthly[ym].outVat += vat }
    else              { monthly[ym].inBase  += base; monthly[ym].inVat  += vat }
  }

  const labels     = Object.keys(monthly).sort()
  const totOut     = labels.reduce((s, l) => s + monthly[l].outVat,  0)
  const totIn      = labels.reduce((s, l) => s + monthly[l].inVat,   0)
  const totOutBase = labels.reduce((s, l) => s + monthly[l].outBase, 0)
  const totInBase  = labels.reduce((s, l) => s + monthly[l].inBase,  0)
  const totNet     = totOut - totIn

  const nc = n => n > 0 ? 'text-red-600 font-bold' : n < 0 ? 'text-green-600 font-bold' : 'text-gray-700 font-bold'

  const rowsHtml = labels.map(ym => {
    const m   = monthly[ym]
    const net = m.outVat - m.inVat
    return `<tr class="border-t border-gray-100 hover:bg-gray-50">
      <td class="px-3 py-2.5 text-sm text-gray-700 font-medium whitespace-nowrap">${formatYM(ym)}</td>
      <td class="px-3 py-2.5 text-sm text-gray-500 text-right">${formatBaht(m.outBase)}</td>
      <td class="px-3 py-2.5 text-sm text-green-600 font-semibold text-right">${formatBaht(m.outVat)}</td>
      <td class="px-3 py-2.5 text-sm text-gray-500 text-right">${formatBaht(m.inBase)}</td>
      <td class="px-3 py-2.5 text-sm text-blue-600 font-semibold text-right">${formatBaht(m.inVat)}</td>
      <td class="px-3 py-2.5 text-sm text-right ${nc(net)}">${formatBaht(net)}</td>
    </tr>`
  }).join('')

  el.innerHTML = `
    <div class="overflow-x-auto rounded-xl border border-gray-200">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="bg-slate-700 text-white text-xs">
            <th class="px-3 py-3 text-left font-semibold">เดือน</th>
            <th class="px-3 py-3 text-right font-semibold">ยอดขาย<br><span class="font-normal opacity-70">(ก่อน VAT)</span></th>
            <th class="px-3 py-3 text-right font-semibold text-green-300">ภาษีขาย 7%</th>
            <th class="px-3 py-3 text-right font-semibold">ยอดซื้อ<br><span class="font-normal opacity-70">(ก่อน VAT)</span></th>
            <th class="px-3 py-3 text-right font-semibold text-blue-300">ภาษีซื้อ 7%</th>
            <th class="px-3 py-3 text-right font-semibold">ภาษีสุทธิ<br><span class="font-normal opacity-70">(PP.30)</span></th>
          </tr>
        </thead>
        <tbody class="bg-white">
          ${rowsHtml}
          <tr class="border-t-2 border-gray-300 bg-gray-50">
            <td class="px-3 py-3 text-sm font-bold text-gray-800">รวม</td>
            <td class="px-3 py-3 text-sm text-gray-700 font-bold text-right">${formatBaht(totOutBase)}</td>
            <td class="px-3 py-3 text-sm text-green-600 font-bold text-right">${formatBaht(totOut)}</td>
            <td class="px-3 py-3 text-sm text-gray-700 font-bold text-right">${formatBaht(totInBase)}</td>
            <td class="px-3 py-3 text-sm text-blue-600 font-bold text-right">${formatBaht(totIn)}</td>
            <td class="px-3 py-3 text-sm text-right ${nc(totNet)}">${formatBaht(totNet)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="flex gap-4 mt-2 text-xs text-gray-400">
      <span><span class="text-red-500 font-semibold">ภาษีสุทธิบวก</span> = ต้องยื่น PP.30 ชำระภาษี</span>
      <span><span class="text-green-600 font-semibold">ภาษีสุทธิลบ</span> = มีเครดิตภาษียกไปเดือนถัดไป</span>
    </div>`
}

// ---- Link Modal (เชื่อมโยงรายการ → Maintain + สมุดรายชื่อ) ----
let linkModalTx = null

function getLinkModalBaseType(isIncome) {
  return isIncome ? 'customer' : 'supplier'
}

function getLinkModalBaseLabel(isIncome) {
  return isIncome ? 'ลูกค้า / คู่ค้า' : 'ร้านค้า / Supplier'
}

function getLinkModalNameLabel(contactType, isIncome) {
  if (contactType === 'internal') return 'ชื่อบัญชีภายใน'
  return isIncome ? 'ชื่อลูกค้า / คู่ค้า' : 'ชื่อร้านค้า / Supplier'
}

function getLinkModalNamePlaceholder(contactType, isIncome) {
  if (contactType === 'internal') return 'เลือกชื่อจากสมุดรายชื่อแท็บ บัญชีภายใน'
  return isIncome ? 'ชื่อลูกค้า...' : 'ชื่อร้านค้า / Supplier...'
}

function getLinkModalSaveLabel(contactType) {
  return contactType === 'internal'
    ? 'บันทึกชื่อเป็นบัญชีภายในในสมุดรายชื่อด้วย'
    : 'บันทึกชื่อในสมุดรายชื่อด้วย'
}

function getLinkModalContacts(contactType) {
  return allContacts
    .filter(contact => contact.type === contactType)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th'))
}

function syncLinkModalSaveContact() {
  const type = document.getElementById('lm-contact-type')?.value
  const name = document.getElementById('lm-name')?.value.trim() || ''
  const checkbox = document.getElementById('lm-save-contact')
  if (!type || !checkbox) return

  const exists = getLinkModalContacts(type).some(contact =>
    normalizeContactName(contact.name) === normalizeContactName(name)
  )
  checkbox.checked = !!name && !exists
}

function updateLinkModalTypeUI() {
  const t = linkModalTx
  if (!t) return

  const isIncome = t.amount > 0
  const type = document.getElementById('lm-contact-type')?.value || getLinkModalBaseType(isIncome)
  const datalist = document.getElementById('lm-contact-list')
  const nameLabel = document.getElementById('lm-name-label')
  const nameInput = document.getElementById('lm-name')
  const saveLabel = document.getElementById('lm-save-contact-label')

  if (datalist) {
    datalist.innerHTML = getLinkModalContacts(type)
      .map(contact => `<option value="${esc(contact.name)}">`)
      .join('')
  }
  if (nameLabel) {
    nameLabel.innerHTML = `${getLinkModalNameLabel(type, isIncome)} <span class="text-red-400">*</span>`
  }
  if (nameInput) {
    nameInput.placeholder = getLinkModalNamePlaceholder(type, isIncome)
  }
  if (saveLabel) {
    saveLabel.textContent = getLinkModalSaveLabel(type)
  }

  syncLinkModalSaveContact()
}

function inferInternalCategory(t, internalName) {
  const currentType = normalizeInternalType(t.category)
  if (INTERNAL_TYPES.has(currentType)) return currentType

  const sourceInternal = findInternalSource(t.account)
  const targetInternal = findContactByName(internalName, 'internal')
  if (!sourceInternal || !targetInternal) return INTERNAL_TYPE_OTHER

  const directorName = resolveInternalDirectorName(sourceInternal, targetInternal, internalName)
  if (isLikelySalaryInternalTx(t, sourceInternal, targetInternal, directorName)) {
    return INTERNAL_TYPE_SALARY
  }

  return classifyInternalDirection(sourceInternal, targetInternal, t.amount) || INTERNAL_TYPE_OTHER
}

function openLinkModal(txId) {
  try {
    linkModalTx = allTransactions.find(t => String(t.id) === String(txId))
    if (!linkModalTx) return

    const modalTitleEl = document.getElementById('link-modal-title')
    const modalFieldsEl = document.getElementById('link-modal-fields')
    const modalEl = document.getElementById('link-modal')
    if (!modalTitleEl || !modalFieldsEl || !modalEl) {
      throw new Error('ไม่พบ element ของหน้าต่างเชื่อมข้อมูล')
    }

    const t        = linkModalTx
    const isIncome = t.amount > 0
    const existing = getMaintainRecord(t)

    modalTitleEl.textContent = isIncome ? 'เชื่อมโยงรายรับ' : 'เชื่อมโยงรายจ่าย'

    const baseType         = getLinkModalBaseType(isIncome)
    const existingName     = existing ? (isIncome ? existing.customer_name : existing.supplier_name) : ''
    const existingDetail   = existing ? (isIncome ? existing.job_name      : existing.details)       : ''
    const existingJobDets  = existing?.job_details || ''
    const existingInfo     = getContactInfo(t)
    const existingContact  = findContactByName(existingName)
    const preferredType    = existingContact?.type || (existingInfo?.type === 'internal' ? 'internal' : baseType)
    const contactType      = preferredType === 'internal' ? 'internal' : baseType
    const defaultName      = existingName || (contactType === 'internal' ? (existingInfo?.name || '') : '')
    const amtColor         = isIncome ? 'text-green-600' : 'text-red-500'
    const amtPrefix        = isIncome ? '+' : '-'

    const datalistHtml = '<datalist id="lm-contact-list"></datalist>'

    let html = `
    ${datalistHtml}
    <div class="mb-4">
      <label class="block text-xs font-medium text-gray-500 mb-1">ประเภทสมุดรายชื่อ</label>
      <select id="lm-contact-type"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400">
        <option value="${baseType}" ${contactType === baseType ? 'selected' : ''}>${getLinkModalBaseLabel(isIncome)}</option>
        <option value="internal" ${contactType === 'internal' ? 'selected' : ''}>🏦 บัญชีภายใน</option>
      </select>
    </div>
    <div class="mb-4 p-3 bg-gray-50 rounded-xl">
      <div class="flex justify-between items-center gap-3">
        <div>
          <p class="text-xs text-gray-400">วันที่</p>
          <p class="text-sm text-gray-700 font-medium">${formatDate(t.date)}</p>
        </div>
        <div class="text-right">
          <p class="text-xs text-gray-400">จำนวนเงิน</p>
          <p class="text-sm font-bold ${amtColor}">${amtPrefix}${formatBaht(Math.abs(t.amount))}</p>
        </div>
      </div>
      ${t.memo ? `<p class="text-xs text-gray-400 mt-2 truncate" title="${esc(t.memo)}">📝 ${esc(t.memo)}</p>` : ''}
    </div>

    <div class="mb-4">
      <label id="lm-name-label" class="block text-xs font-medium text-gray-500 mb-1">
        ${getLinkModalNameLabel(contactType, isIncome)}
        <span class="text-red-400">*</span>
      </label>
      <input id="lm-name" type="text" list="lm-contact-list" value="${esc(defaultName)}"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
        placeholder="${getLinkModalNamePlaceholder(contactType, isIncome)}">
    </div>

    <div class="mb-4">
      <label class="block text-xs font-medium text-gray-500 mb-1">
        ${isIncome ? 'ชื่องาน / โปรเจกต์' : 'รายละเอียด / สินค้าหรือบริการ'}
      </label>
      ${isIncome
        ? `<input id="lm-detail" type="text" value="${esc(existingDetail)}"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
            placeholder="เช่น ติดตั้งโซลาร์เซลล์ บ้านคุณสมชาย">`
        : `<textarea id="lm-detail" rows="3"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-none"
            placeholder="รายละเอียดสินค้า / บริการ...">${esc(existingDetail)}</textarea>`}
    </div>`

    if (isIncome) {
      html += `
    <div class="mb-4">
      <label class="block text-xs font-medium text-gray-500 mb-1">รายละเอียดงานเพิ่มเติม</label>
      <textarea id="lm-job-details" rows="2"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-none"
        placeholder="รายละเอียดเพิ่มเติม...">${esc(existingJobDets)}</textarea>
    </div>`
    }

    const nameInContacts = getLinkModalContacts(contactType)
      .some(contact => normalizeContactName(contact.name) === normalizeContactName(defaultName))
    html += `
    <div class="flex items-center gap-2 pt-1 border-t border-gray-100 mt-2">
      <input type="checkbox" id="lm-save-contact" class="rounded accent-yellow-500"
        ${defaultName && !nameInContacts ? 'checked' : ''}>
      <label for="lm-save-contact" id="lm-save-contact-label" class="text-xs text-gray-500 cursor-pointer">
        ${getLinkModalSaveLabel(contactType)}
      </label>
      <a href="contacts.html" target="_blank"
        class="ml-auto text-xs text-yellow-600 hover:underline whitespace-nowrap">
        เปิดสมุดรายชื่อ ↗
      </a>
    </div>`

    modalFieldsEl.innerHTML = html
    modalEl.classList.remove('hidden')
    document.body.classList.add('overflow-hidden')
    document.getElementById('lm-contact-type')?.addEventListener('change', updateLinkModalTypeUI)
    document.getElementById('lm-name')?.addEventListener('input', syncLinkModalSaveContact)
    updateLinkModalTypeUI()
    document.getElementById('lm-name')?.focus()
  } catch (err) {
    console.error('openLinkModal failed:', err)
    alert('เปิดหน้าต่างเชื่อมข้อมูลไม่สำเร็จ: ' + err.message)
  }
}

function closeLinkModal() {
  document.getElementById('link-modal').classList.add('hidden')
  document.body.classList.remove('overflow-hidden')
  linkModalTx = null
}

async function saveLinkRecord() {
  const btn = document.getElementById('link-btn-save')
  btn.disabled = true
  btn.textContent = 'กำลังบันทึก...'

  try {
    const t = linkModalTx
    if (!t) return

    const isIncome    = t.amount > 0
    const contactType = document.getElementById('lm-contact-type')?.value || getLinkModalBaseType(isIncome)
    const name        = document.getElementById('lm-name').value.trim()
    if (!name) {
      if (contactType === 'internal') {
        alert('กรุณากรอกชื่อบัญชีภายใน')
      } else {
        alert(isIncome ? 'กรุณากรอกชื่อลูกค้า' : 'กรุณากรอกชื่อร้านค้า / Supplier')
      }
      return
    }

    const detail      = document.getElementById('lm-detail').value.trim()
    const saveContact = document.getElementById('lm-save-contact').checked
    const existing    = getMaintainRecord(t)

    let payload, table
    if (isIncome) {
      const jobDetails = document.getElementById('lm-job-details')?.value.trim() || null
      payload = {
        customer_name:    name,
        job_name:         detail   || null,
        job_details:      jobDetails,
        transaction_date: t.date,
        amount:           t.amount,
        transaction_id:   t.id,
        account_number:   existing?.account_number || null,
        file_url:         existing?.file_url  || null,
        file_name:        existing?.file_name || null,
      }
      table = 'income_records'
    } else {
      payload = {
        supplier_name:    name,
        details:          detail || null,
        transaction_date: t.date,
        amount:           Math.abs(t.amount),
        transaction_id:   t.id,
        account_number:   existing?.account_number || null,
        file_url:         existing?.file_url  || null,
        file_name:        existing?.file_name || null,
      }
      table = 'expense_records'
    }

    await upsertMaintainRecord(table, payload, existing?.id || null)

    const nextCategory = contactType === 'internal'
      ? inferInternalCategory(t, name)
      : (INTERNAL_TYPES.has(normalizeInternalType(t.category)) ? null : undefined)

    if (nextCategory !== undefined) {
      const { error } = await db.from('transactions').update({ category: nextCategory }).eq('id', t.id)
      if (error) throw error
      const tx = allTransactions.find(row => String(row.id) === String(t.id))
      if (tx) tx.category = nextCategory
    }

    if (saveContact) {
      const exists = allContacts.find(c =>
        c.type === contactType &&
        normalizeContactName(c.name) === normalizeContactName(name)
      )
      if (!exists) {
        await db.from('contacts').insert({ type: contactType, name })
      }
    }

    await Promise.all([loadMaintainRecords(), loadContactsMap()])
    renderAll(allTransactions)
    closeLinkModal()

  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message)
  } finally {
    btn.disabled = false
    btn.textContent = 'บันทึก'
  }
}

// ---- Helpers ----
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function formatBaht(n) {
  return '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 })
}
function formatDate(str) {
  if (!str) return '—'
  const [y, m, d] = str.split('-')
  return `${d}/${m}/${y}`
}
function formatYM(ym) {
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']
  const [y, m] = ym.split('-')
  return `${months[parseInt(m) - 1]} ${parseInt(y) + 543}`
}
function setText(id, text) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}
function populateSelect(id, options) {
  const el = document.getElementById(id)
  if (!el) return
  el.innerHTML = '<option value="">ทั้งหมด</option>' +
    options.map(o => `<option value="${o}">${o}</option>`).join('')
}

// ──────────────────────────────────────────────────────────────────────
// Auto Sync: Fuzzy-match transactions → counterparty_master (contacts)
// ──────────────────────────────────────────────────────────────────────

const AUTO_SYNC_REVIEW_THRESHOLD = 0.68
const AUTO_SYNC_AUTO_THRESHOLD   = 0.88
const AUTO_SYNC_STOPWORDS = new Set([
  'จาก', 'โอนไป', 'เพื่อชำระ', 'รหัสอ้างอิง', 'ref', 'payment', 'qr',
  'นาย', 'นาง', 'นางสาว', 'คุณ', 'mr', 'mrs', 'ms', 'miss',
  'บริษัท', 'บจก', 'หจก', 'ร้าน', 'co', 'ltd', 'limited', 'of', 'the',
  'bay', 'ktb', 'scb', 'bbl', 'gsb', 'uobt', 'ttb', 'scbt', 'kk', 'kkp', 'kbank',
])
const AUTO_SYNC_BANK_HINTS = ['bay', 'ktb', 'scb', 'bbl', 'gsb', 'uobt', 'ttb', 'scbt', 'kk', 'kkp', 'kbank']

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeAutoSyncText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\+\+/g, ' ')
    .replace(/[(),_/\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactAutoSyncText(value) {
  return normalizeAutoSyncText(value).replace(/[^a-z0-9\u0E00-\u0E7F]/g, '')
}

function stripLeadingMatchNoise(text) {
  let result = normalizeAutoSyncText(text)
  const prefixes = [
    'นาย ', 'นางสาว ', 'น.ส. ', 'น.ส ', 'นาง ', 'คุณ ',
    'mr. ', 'mr ', 'mrs. ', 'mrs ', 'ms. ', 'ms ', 'miss ',
    'บริษัท ', 'บจก. ', 'บจก ', 'หจก. ', 'หจก ', 'ร้าน ',
  ]
  let changed = true
  while (changed) {
    changed = false
    for (const prefix of prefixes) {
      if (result.startsWith(prefix)) {
        result = result.slice(prefix.length).trim()
        changed = true
      }
    }
  }
  return result
}

function removeAutoSyncNoise(text) {
  let result = normalizeAutoSyncText(text)
  const phrases = ['จาก', 'โอนไป', 'เพื่อชำระ', 'รหัสอ้างอิง', 'qr payment', 'promptpay', 'payment', 'ref']
  for (const phrase of phrases) {
    result = result.replace(new RegExp(escapeRegExp(phrase), 'gi'), ' ')
  }
  result = result.replace(/\bkb\d+\b/gi, ' ')
  result = result.replace(/\bx\d{4}\b/gi, ' ')
  result = result.replace(/\b(?:bay|ktb|scb|bbl|gsb|uobt|ttb|scbt|kk|kkp|kbank)\b/gi, ' ')
  return normalizeAutoSyncText(result)
}

function stripLeadingBankHint(text) {
  let result = normalizeAutoSyncText(text)
  let changed = true
  while (changed) {
    changed = false
    for (const hint of AUTO_SYNC_BANK_HINTS) {
      const prefix = `${hint} `
      if (result.startsWith(prefix)) {
        result = result.slice(prefix.length).trim()
        changed = true
      }
    }
  }
  return result
}

function extractAutoSyncBankHints(text) {
  const normalized = normalizeAutoSyncText(text)
  const found = new Set()
  for (const hint of AUTO_SYNC_BANK_HINTS) {
    if (normalized.includes(hint)) found.add(hint)
  }
  return found
}

function parseContactAliasNotes(contact) {
  const note = String(contact?.notes || '')
  if (!note) return []
  return note
    .split(/[\n,|/]/)
    .map(part => part.trim())
    .filter(Boolean)
}

function pushUniqueAutoSyncCandidate(items, seen, text, source) {
  const normalized = normalizeAutoSyncText(text)
  if (!normalized || seen.has(normalized)) return
  seen.add(normalized)
  items.push({ text: normalized, source })
}

function buildAutoSyncTextCandidates(memo) {
  const items = []
  const seen = new Set()
  const counterparty = extractCounterparty(memo)

  pushUniqueAutoSyncCandidate(items, seen, counterparty, 'ชื่อคู่รายการ')
  pushUniqueAutoSyncCandidate(items, seen, stripLeadingMatchNoise(counterparty), 'ชื่อคู่รายการ')
  pushUniqueAutoSyncCandidate(items, seen, removeAutoSyncNoise(counterparty), 'ชื่อคู่รายการ')
  pushUniqueAutoSyncCandidate(items, seen, removeAutoSyncNoise(memo), 'memo')
  pushUniqueAutoSyncCandidate(items, seen, memo, 'memo')

  return items
}

function buildContactNameCandidates(contact) {
  const items = []
  const seen = new Set()
  const push = (text) => {
    const normalized = normalizeAutoSyncText(text)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    items.push(normalized)
  }

  push(contact?.name)
  push(stripLeadingMatchNoise(contact?.name))
  push(stripLeadingBankHint(contact?.name))
  push(stripLeadingMatchNoise(stripLeadingBankHint(contact?.name)))
  push(removeAutoSyncNoise(contact?.name))
  push(stripLeadingMatchNoise(removeAutoSyncNoise(contact?.name)))

  if (contact?.type === 'internal') {
    const directorCanonical = getDirectorCanonicalName(contact)
    if (directorCanonical) {
      push(directorCanonical)
      const profile = findDirectorProfile(directorCanonical)
      for (const alias of profile?.aliases || []) {
        push(alias)
        push(stripLeadingMatchNoise(alias))
      }
    }
    for (const alias of parseContactAliasNotes(contact)) {
      push(alias)
      push(stripLeadingMatchNoise(alias))
      push(stripLeadingBankHint(alias))
    }
  }

  return items
}

function tokenizeAutoSyncText(text) {
  return normalizeAutoSyncText(text)
    .split(/\s+/)
    .map(token => token.replace(/^[^a-z0-9\u0E00-\u0E7F]+|[^a-z0-9\u0E00-\u0E7F]+$/g, ''))
    .filter(token => token.length >= 2 && !AUTO_SYNC_STOPWORDS.has(token))
}

function tokenOverlapScore(text, name) {
  const left = new Set(tokenizeAutoSyncText(text))
  const right = new Set(tokenizeAutoSyncText(name))
  if (!left.size || !right.size) return 0

  let overlap = 0
  for (const token of left) {
    if (right.has(token)) overlap++
  }
  if (!overlap) return 0

  const maxSize = Math.max(left.size, right.size)
  const minSize = Math.min(left.size, right.size)
  return Math.min(0.9, 0.6 + (overlap / maxSize) * 0.22 + (overlap / minSize) * 0.08)
}

function levenshteinDist(a, b) {
  if (Math.abs(a.length - b.length) > 30) return Math.max(a.length, b.length)
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1])
    }
    prev = curr
  }
  return prev[b.length]
}

function fuzzyScore(text, name) {
  if (!text || !name) return 0
  const t = text.toLowerCase().trim()
  const n = name.toLowerCase().trim()
  if (!t || !n) return 0
  if (t === n) return 1
  if (t.includes(n)) return 0.88 + 0.12 * Math.min(1, n.length / t.length)
  if (n.includes(t)) return 0.88 + 0.12 * Math.min(1, t.length / n.length)
  const ta = t.slice(0, 50), na = n.slice(0, 50)
  const lev = levenshteinDist(ta, na)
  return Math.max(0, 1 - lev / Math.max(ta.length, na.length))
}

function compareAutoSyncText(text, name) {
  const left = normalizeAutoSyncText(text)
  const right = normalizeAutoSyncText(name)
  if (!left || !right) return 0

  const compactLeft = compactAutoSyncText(left)
  const compactRight = compactAutoSyncText(right)

  if (left === right || compactLeft === compactRight) return 0.99
  if (left.includes(right) || right.includes(left)) {
    return 0.9 + 0.08 * Math.min(left.length, right.length) / Math.max(left.length, right.length)
  }
  if (compactLeft && compactRight && (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))) {
    return 0.88 + 0.06 * Math.min(compactLeft.length, compactRight.length) / Math.max(compactLeft.length, compactRight.length)
  }

  return Math.max(
    tokenOverlapScore(left, right),
    fuzzyScore(stripLeadingMatchNoise(left), stripLeadingMatchNoise(right)) * 0.9
  )
}

function scoreContactCodeMatch(memo, contact) {
  const code = compactAutoSyncText(contact?.account_number)
  if (!code || code.length < 4) return null

  const memoCompact = compactAutoSyncText(memo)
  if (!memoCompact || !memoCompact.includes(code)) return null

  return {
    score: 1,
    reason: `ตรงรหัส ${contact.account_number}`,
  }
}

function scoreInternalBankHint(contact, memo) {
  const memoBanks = extractAutoSyncBankHints(memo)
  if (!memoBanks.size) return 0
  const contactBanks = extractAutoSyncBankHints(`${contact?.name || ''} ${contact?.notes || ''}`)
  if (!contactBanks.size) return 0
  for (const hint of memoBanks) {
    if (contactBanks.has(hint)) return 0.06
  }
  return 0
}

function getAutoSyncContactType(t) {
  return t.amount > 0 ? 'customer' : 'supplier'
}

function getAutoSyncReason(source, score) {
  if (source === 'code') return 'ตรงรหัสบัญชี / รหัส X####'
  if (score >= 0.95) return source === 'ชื่อคู่รายการ' ? 'ตรงชื่อคู่รายการ' : 'ตรงชื่อใน memo'
  return source === 'ชื่อคู่รายการ' ? 'ชื่อคู่รายการใกล้เคียง' : 'ชื่อใน memo ใกล้เคียง'
}

function bestExternalContactMatch(t) {
  if (!t?.memo || !allContacts.length) return null

  const matchType = getAutoSyncContactType(t)
  const contacts = allContacts.filter(contact => contact.type === matchType)
  if (!contacts.length) return null

  const candidates = buildAutoSyncTextCandidates(t.memo)
  let best = null
  let bestScore = 0
  let bestReason = ''

  for (const contact of contacts) {
    const codeMatch = scoreContactCodeMatch(t.memo, contact)
    if (codeMatch && codeMatch.score > bestScore) {
      best = contact
      bestScore = codeMatch.score
      bestReason = codeMatch.reason
    }

    const nameCandidates = buildContactNameCandidates(contact)
    for (const candidate of candidates) {
      for (const name of nameCandidates) {
        const score = compareAutoSyncText(candidate.text, name)
        if (score > bestScore) {
          best = contact
          bestScore = score
          bestReason = getAutoSyncReason(candidate.source, score)
        }
      }
    }
  }

  return (best && bestScore >= AUTO_SYNC_REVIEW_THRESHOLD)
    ? { contact: best, score: Math.min(bestScore, 1), reason: bestReason }
    : null
}

function getEligibleInternalAutoSyncContacts(t) {
  const sourceInternal = findInternalSource(t.account)
  const sourceRole = resolveInternalRole(sourceInternal)
  if (!sourceRole) return []

  const sourceName = normalizeContactName(sourceInternal?.name)
  return allContacts.filter(contact =>
    contact.type === 'internal' &&
    !!resolveInternalRole(contact) &&
    normalizeContactName(contact.name) !== sourceName
  )
}

function bestInternalContactMatch(t) {
  if (!t?.memo || !allContacts.length) return null

  const contacts = getEligibleInternalAutoSyncContacts(t)
  if (!contacts.length) return null

  const candidates = buildAutoSyncTextCandidates(t.memo)
  let best = null
  let bestScore = 0
  let bestReason = ''

  for (const contact of contacts) {
    const codeMatch = scoreContactCodeMatch(t.memo, contact)
    if (codeMatch && codeMatch.score > bestScore) {
      best = contact
      bestScore = codeMatch.score
      bestReason = codeMatch.reason
    }

    const nameCandidates = buildContactNameCandidates(contact)
    const bankBoost = scoreInternalBankHint(contact, t.memo)
    const salaryPattern = scoreDirectorSalaryPattern(t, contact)
    for (const candidate of candidates) {
      for (const name of nameCandidates) {
        const score = Math.min(1, compareAutoSyncText(candidate.text, name) + bankBoost + (salaryPattern?.score || 0))
        if (score > bestScore) {
          best = contact
          bestScore = score
          const baseReason = getAutoSyncReason(candidate.source, score)
          const reasonParts = [baseReason]
          if (bankBoost) reasonParts.push('ตรงธนาคาร')
          if (salaryPattern?.reason) reasonParts.push(salaryPattern.reason)
          bestReason = reasonParts.join(' + ')
        }
      }
    }
  }

  return (best && bestScore >= AUTO_SYNC_REVIEW_THRESHOLD)
    ? { contact: best, score: Math.min(bestScore, 1), reason: bestReason || 'บัญชีภายในใกล้เคียง' }
    : null
}

function bestContactMatch(t) {
  const internalMatch = bestInternalContactMatch(t)
  const externalMatch = bestExternalContactMatch(t)

  if (internalMatch && externalMatch) {
    return internalMatch.score >= externalMatch.score + 0.03 ? internalMatch : externalMatch
  }
  return internalMatch || externalMatch || null
}

function getPersistedMatchInfo(t) {
  const maintained = getMaintainedContactInfo(t)
  return maintained?.source === 'maintain' ? maintained : null
}

function getHeuristicAutoSyncMatch(t) {
  const info = getContactInfo(t)
  if (!info || info.source !== 'contact' || !info.name) return null
  const isRecognizedInternal = hasRecognizedInternalInfo(info, t)
  if (info.type === 'internal' && !isRecognizedInternal) return null
  return {
    contact: { name: info.name, type: isRecognizedInternal ? 'internal' : (info.type || '') },
    score: isRecognizedInternal ? 0.99 : 0.95,
    reason: isRecognizedInternal
      ? 'ตรงบัญชีภายในจาก memo'
      : 'ตรงข้อมูลสมุดรายชื่อจาก memo',
  }
}

async function runAutoSync() {
  const btn = document.getElementById('auto-sync-btn')
  btn.disabled = true
  btn.textContent = '⏳ วิเคราะห์...'
  try {
    await loadContactsMap()
    const matchableContacts = allContacts.filter(c =>
      c.type === 'customer' ||
      c.type === 'supplier' ||
      (c.type === 'internal' && !!resolveInternalRole(c))
    )
    if (!matchableContacts.length) {
      showSyncToast('ไม่พบรายชื่อที่ใช้ Auto Sync ในสมุดรายชื่อ — กรุณาเพิ่มรายชื่อก่อน', 'info')
      return
    }
    const toProcess = currentRows.filter(t => t.amount !== 0 && !getPersistedMatchInfo(t))
    if (!toProcess.length) {
      showSyncToast('✅ ทุกรายการมีการจับคู่แล้ว', 'green')
      return
    }
    autoSyncAutoItems   = []
    autoSyncReviewItems = []
    const noMatchItems  = []
    for (const t of toProcess) {
      const heuristicMatch = getHeuristicAutoSyncMatch(t)
      if (heuristicMatch) {
        autoSyncAutoItems.push({
          t,
          contact: heuristicMatch.contact,
          score: heuristicMatch.score,
          reason: heuristicMatch.reason,
        })
        continue
      }
      const match = bestContactMatch(t)
      if (!match)               noMatchItems.push({ t })
      else if (match.score >= AUTO_SYNC_AUTO_THRESHOLD) autoSyncAutoItems.push({ t, contact: match.contact, score: match.score, reason: match.reason })
      else                        autoSyncReviewItems.push({ t, contact: match.contact, score: match.score, reason: match.reason })
    }
    syncResults = new Map()
    for (const { t } of noMatchItems)
      syncResults.set(String(t.id), { status: 'unmatched' })
    for (const { t, contact, score, reason } of autoSyncAutoItems)
      syncResults.set(String(t.id), { status: 'auto', contact, score, reason })
    for (const { t, contact, score, reason } of autoSyncReviewItems)
      syncResults.set(String(t.id), { status: 'review', contact, score, reason })
    renderAutoSyncModal(autoSyncAutoItems, autoSyncReviewItems, noMatchItems)
    renderTable(currentRows)
  } finally {
    btn.disabled = false
    btn.textContent = '⚡ Auto Sync'
  }
}

function renderAutoSyncModal(autoItems, reviewItems, noMatchItems) {
  const total = autoItems.length + reviewItems.length + noMatchItems.length
  const autoPct = Math.round(AUTO_SYNC_AUTO_THRESHOLD * 100)
  const reviewPct = Math.round(AUTO_SYNC_REVIEW_THRESHOLD * 100)
  const html = `
    <div class="space-y-4">
      <div class="grid grid-cols-3 gap-3">
        <div class="bg-green-50 border border-green-200 rounded-xl p-3 text-center">
          <p class="text-2xl font-bold text-green-600">${autoItems.length}</p>
          <p class="text-xs text-green-700 font-medium mt-0.5">จับคู่อัตโนมัติ</p>
          <p class="text-[10px] text-green-500 opacity-80">≥${autoPct}% — เลือกเพื่อบันทึก</p>
        </div>
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-center">
          <p class="text-2xl font-bold text-amber-600">${reviewItems.length}</p>
          <p class="text-xs text-amber-700 font-medium mt-0.5">รอยืนยัน</p>
          <p class="text-[10px] text-amber-500 opacity-80">${reviewPct}–${autoPct - 1}% — เลือกเพื่อยืนยัน</p>
        </div>
        <div class="bg-red-50 border border-red-200 rounded-xl p-3 text-center">
          <p class="text-2xl font-bold text-red-500">${noMatchItems.length}</p>
          <p class="text-xs text-red-600 font-medium mt-0.5">ไม่พบ</p>
          <p class="text-[10px] text-red-400 opacity-80">&lt;${reviewPct}% — กรอกด้วยตนเอง</p>
        </div>
      </div>
      <p class="text-xs text-gray-400">วิเคราะห์ ${total} รายการที่ยังไม่ได้จับคู่ จาก ${currentRows.length} รายการที่แสดงอยู่</p>
      ${autoItems.length   ? renderSyncSection(autoItems,   0,                true,  `✅ จับคู่อัตโนมัติ (≥${autoPct}%)`) : ''}
      ${reviewItems.length ? renderSyncSection(reviewItems, autoItems.length, false, `⚠ ต้องยืนยัน (${reviewPct}–${autoPct - 1}%)`) : ''}
      ${noMatchItems.length ? renderUnmatchedSection(noMatchItems) : ''}
    </div>`
  document.getElementById('auto-sync-content').innerHTML = html
  document.getElementById('auto-sync-modal').classList.remove('hidden')
  document.body.classList.add('overflow-hidden')
}

function renderSyncSection(items, startIdx, preChecked, title) {
  const endIdx = startIdx + items.length - 1
  const rows = items.map((item, i) => {
    const idx = startIdx + i
    const { t, contact, score, reason } = item
    const pct = Math.round(score * 100)
    const pctColor = score >= AUTO_SYNC_AUTO_THRESHOLD ? 'text-green-600' : 'text-amber-600'
    const amtHtml = t.amount > 0
      ? `<span class="text-green-600 font-semibold text-xs">+${formatBaht(t.amount)}</span>`
      : `<span class="text-red-500 font-semibold text-xs">${formatBaht(t.amount)}</span>`
    const typeBadge = contact.type === 'customer'
      ? '<span class="text-[9px] bg-blue-100 text-blue-600 rounded px-1 ml-1">ลูกค้า</span>'
      : contact.type === 'internal'
        ? '<span class="text-[9px] bg-violet-100 text-violet-700 rounded px-1 ml-1">บัญชีภายใน</span>'
        : '<span class="text-[9px] bg-orange-100 text-orange-600 rounded px-1 ml-1">Supplier</span>'
    const memoText = (t.memo || '').slice(0, 70)
    const reasonHtml = reason
      ? `<div class="text-[10px] text-gray-400 font-normal mt-0.5">${esc(reason)}</div>`
      : ''
    return `<tr class="border-t border-gray-100 hover:bg-gray-50">
      <td class="px-3 py-2"><input type="checkbox" id="sync-cb-${idx}" ${preChecked ? 'checked' : ''}
        class="w-4 h-4 rounded accent-yellow-500 cursor-pointer"></td>
      <td class="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">${formatDate(t.date)}</td>
      <td class="px-3 py-2 text-xs">${amtHtml}</td>
      <td class="px-3 py-2 text-xs text-gray-500 max-w-[280px] truncate" title="${esc(t.memo || '')}">${esc(memoText)}</td>
      <td class="px-3 py-2 text-xs text-gray-800"><div class="font-semibold">${esc(contact.name)}${typeBadge}</div>${reasonHtml}</td>
      <td class="px-3 py-2 text-xs font-bold ${pctColor}">${pct}%</td>
    </tr>`
  }).join('')
  return `<div class="border border-gray-200 rounded-xl overflow-hidden">
    <div class="px-4 py-2.5 bg-gray-50 flex items-center justify-between">
      <span class="text-sm font-semibold text-gray-700">${title}</span>
      <label class="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
        <input type="checkbox" onchange="toggleSyncSection(${startIdx},${endIdx},this.checked)" ${preChecked ? 'checked' : ''}
          class="w-3.5 h-3.5 rounded accent-yellow-500"> เลือกทั้งหมด
      </label>
    </div>
    <div class="overflow-x-auto">
      <table class="min-w-full">
        <thead class="bg-gray-50 text-[10px] text-gray-400 uppercase tracking-wide">
          <tr>
            <th class="px-3 py-2 w-8"></th>
            <th class="px-3 py-2 text-left">วันที่</th>
            <th class="px-3 py-2 text-left">จำนวน</th>
            <th class="px-3 py-2 text-left">Memo</th>
            <th class="px-3 py-2 text-left">จับคู่กับ (สมุดรายชื่อ)</th>
            <th class="px-3 py-2 text-left">ความมั่นใจ</th>
          </tr>
        </thead>
        <tbody class="bg-white">${rows}</tbody>
      </table>
    </div>
  </div>`
}

function renderUnmatchedSection(items) {
  const rows = items.map(({ t }) => {
    const amtHtml = t.amount > 0
      ? `<span class="text-green-600 text-xs">+${formatBaht(t.amount)}</span>`
      : `<span class="text-red-500 text-xs">${formatBaht(t.amount)}</span>`
    return `<tr class="border-t border-gray-100">
      <td class="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">${formatDate(t.date)}</td>
      <td class="px-3 py-2">${amtHtml}</td>
      <td class="px-3 py-2 text-xs text-gray-400 max-w-[200px] truncate" title="${esc(t.memo || '')}">${esc((t.memo || '').slice(0, 40))}</td>
      <td class="px-3 py-2 text-xs text-red-400 italic">ไม่พบในสมุดรายชื่อ — ใช้ปุ่ม ✎ เชื่อม</td>
    </tr>`
  }).join('')
  return `<div class="border border-red-200 rounded-xl overflow-hidden">
    <div class="px-4 py-2.5 bg-red-50">
      <span class="text-sm font-semibold text-red-600">❌ ไม่พบ (&lt;${Math.round(AUTO_SYNC_REVIEW_THRESHOLD * 100)}%) — กรอกด้วยตนเอง</span>
    </div>
    <div class="overflow-x-auto">
      <table class="min-w-full">
        <thead class="bg-red-50 text-[10px] text-red-300 uppercase tracking-wide">
          <tr>
            <th class="px-3 py-2 text-left">วันที่</th>
            <th class="px-3 py-2 text-left">จำนวน</th>
            <th class="px-3 py-2 text-left">Memo</th>
            <th class="px-3 py-2 text-left">หมายเหตุ</th>
          </tr>
        </thead>
        <tbody class="bg-white">${rows}</tbody>
      </table>
    </div>
  </div>`
}

function toggleSyncSection(fromIdx, toIdx, checked) {
  for (let i = fromIdx; i <= toIdx; i++) {
    const cb = document.getElementById(`sync-cb-${i}`)
    if (cb) cb.checked = checked
  }
}

async function saveSyncSelections() {
  const btn = document.getElementById('sync-save-btn')
  btn.disabled = true
  btn.textContent = 'กำลังบันทึก...'
  try {
    const activeFilters = getActiveDashboardFilters()
    const allPending = [...autoSyncAutoItems, ...autoSyncReviewItems]
    const toSave = allPending.filter((_, i) => {
      const cb = document.getElementById(`sync-cb-${i}`)
      return cb?.checked
    })
    if (!toSave.length) {
      showSyncToast('ไม่มีรายการที่เลือก', 'info')
      return
    }
    let saved = 0, errors = 0
    const errorDetails = []
    for (const { t, contact } of toSave) {
      try {
        await saveAutoSyncMatch(t, contact.name, contact.type)
        saved++
      } catch (e) {
        console.error('Auto sync save error:', e)
        errors++
        errorDetails.push(`- ${formatDate(t.date)} | ${formatBaht(Math.abs(t.amount))} | ${String(e.message || e)}`)
      }
    }
    syncResults = new Map()
    autoSyncAutoItems   = []
    autoSyncReviewItems = []
    await reloadDashboardView(activeFilters)
    closeAutoSyncModal()
    if (errorDetails.length) {
      alert([
        `Auto Sync บันทึกสำเร็จ ${saved} รายการ`,
        `บันทึกไม่สำเร็จ ${errors} รายการ`,
        '',
        ...errorDetails.slice(0, 10),
      ].join('\n'))
    }
    showSyncToast(
      errors ? `บันทึก ${saved} รายการ (ข้อผิดพลาด ${errors})` : `✅ บันทึกสำเร็จ ${saved} รายการ`,
      errors ? 'red' : 'green'
    )
  } finally {
    btn.disabled = false
    btn.textContent = 'บันทึกที่เลือก'
  }
}

async function saveAutoSyncMatch(t, contactName, contactType = '') {
  const isIncome = t.amount > 0
  const existing = getMaintainRecord(t)
  if (isIncome) {
    const payload = { customer_name: contactName, transaction_date: t.date, amount: t.amount, transaction_id: t.id }
    await upsertMaintainRecord('income_records', payload, existing?.id || null)
  } else {
    const payload = { supplier_name: contactName, transaction_date: t.date, amount: Math.abs(t.amount), transaction_id: t.id }
    await upsertMaintainRecord('expense_records', payload, existing?.id || null)
  }

  const nextCategory = contactType === 'internal'
    ? inferInternalCategory(t, contactName)
    : (INTERNAL_TYPES.has(normalizeInternalType(t.category)) ? null : undefined)

  if (nextCategory !== undefined) {
    const result = await db.from('transactions')
      .update({ category: nextCategory })
      .eq('id', t.id)
      .select('id, category')

    if (result.error) throw result.error
    if (!result.data || result.data.length === 0) {
      throw new Error('ไม่สามารถอัปเดต transactions.category ได้ — ตรวจสอบ Supabase RLS Policy (UPDATE permission)')
    }
    const tx = allTransactions.find(row => String(row.id) === String(t.id))
    if (tx) tx.category = nextCategory
  }
}

function closeAutoSyncModal() {
  document.getElementById('auto-sync-modal').classList.add('hidden')
  document.body.classList.remove('overflow-hidden')
}

async function resetMatch(txId) {
  const t = allTransactions.find(t => String(t.id) === String(txId))
  if (!t) return

  const existing = getMaintainRecord(t)

  if (existing?.id) {
    if (!confirm('ลบการจับคู่นี้และรีเซ็ต เพื่อ Match ใหม่?')) return
    const table = t.amount > 0 ? 'income_records' : 'expense_records'
    const { error } = await db.from(table).delete().eq('id', existing.id)
    if (error) { alert('รีเซ็ตไม่สำเร็จ: ' + error.message); return }
    await loadMaintainRecords()
  }

  if (INTERNAL_TYPES.has(normalizeInternalType(t.category))) {
    const { error } = await db.from('transactions').update({ category: null }).eq('id', txId)
    if (error) { alert('รีเซ็ตประเภทภายในไม่สำเร็จ: ' + error.message); return }
    t.category = null
  }

  syncResults.delete(String(txId))
  renderTable(currentRows)
}

// ──────────────────────────────────────────────────────────────────────
// Internal Transaction Detection — โอนระหว่างบัญชี / เงินเดือน / Advance / ปันผล
// ──────────────────────────────────────────────────────────────────────

const SALARY_RANGE    = { min: 13000, max: 17000 }
const SALARY_DAY_MAX  = 12
const CHAIYAWAT_CODES = ['X3006', 'X8624']
const DIRECTOR_PROFILES = [
  {
    canonical: 'น.ส. อาภาพร เทพจันทร์',
    aliases: [
      'น.ส. อาภาพร เทพจันทร์',
      'อาภาพร เทพจันทร์',
      'อาภาพร',
      'apaporn thepjan',
      'apaporn thepchan',
      'apaporn thepjun',
      'apaporn the',
      'apaporn',
      'apaporn tep',
    ],
  },
  {
    canonical: 'นาย วสันต์ ปานแย้ม',
    aliases: [
      'นาย วสันต์ ปานแย้ม',
      'วสันต์ ปานแย้ม',
      'วสันต์',
      'wasan panyaim',
      'wasan panyam',
      'wasan pany',
      'wasan pan',
      'wasan',
    ],
  },
  {
    canonical: 'นายชัยวัฒน์ เทพจันทร์',
    aliases: [
      'นายชัยวัฒน์ เทพจันทร์',
      'นาย ชัยวัฒน์ เทพจันทร์',
      'ชัยวัฒน์ เทพจันทร์',
      'ชัยวัฒน์',
      'chaiyawat thepjan',
      'chaiyawat thepchan',
      'chaiyawat the',
      'chaiyawat',
      'chaiwat',
    ],
  },
]
const INTERNAL_TYPE_TRANSFER = 'โอนระหว่างบัญชี'
const INTERNAL_TYPE_OUT      = 'โอนออกให้กรรมการ'
const INTERNAL_TYPE_IN       = 'โอนเข้าจากกรรมการ'
const INTERNAL_TYPE_ADVANCE  = 'เคลียร์การเบิกจ่าย'
const INTERNAL_TYPE_DIVIDEND = 'ปันผลกรรมการ'
const INTERNAL_TYPE_SALARY   = 'เงินเดือน'
const INTERNAL_TYPE_OTHER    = 'อื่นๆ'
const INTERNAL_TYPE_ALIAS    = new Map([
  ['Advance', INTERNAL_TYPE_ADVANCE],
  ['Advance ชัยวัฒน์', INTERNAL_TYPE_ADVANCE],
])
const INTERNAL_TYPE_OPTIONS = [
  INTERNAL_TYPE_TRANSFER,
  INTERNAL_TYPE_OUT,
  INTERNAL_TYPE_IN,
  INTERNAL_TYPE_ADVANCE,
  INTERNAL_TYPE_DIVIDEND,
  INTERNAL_TYPE_SALARY,
  INTERNAL_TYPE_OTHER,
]
const INTERNAL_TYPES = new Set([...INTERNAL_TYPE_OPTIONS, ...INTERNAL_TYPE_ALIAS.keys()])
const FIXED_DIRECTOR_SALARY_RULES = [
  { canonical: 'น.ส. อาภาพร เทพจันทร์', amount: 15000, dayMax: 3 },
  { canonical: 'นาย วสันต์ ปานแย้ม', amount: 15000, dayMax: 3 },
]

function normInternalText(v) {
  return String(v || '').trim().toLowerCase()
}

function normalizeInternalType(v) {
  const raw = String(v || '').trim()
  return INTERNAL_TYPE_ALIAS.get(raw) || raw
}

function normalizeDirectorText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function findDirectorProfile(text) {
  const normalized = normalizeDirectorText(text)
  if (!normalized) return null
  return DIRECTOR_PROFILES.find(profile =>
    profile.aliases.some(alias => normalized.includes(normalizeDirectorText(alias)))
  ) || null
}

function getDirectorCanonicalName(value) {
  if (!value) return null
  if (typeof value === 'string') return findDirectorProfile(value)?.canonical || null
  return findDirectorProfile(value.name || value.notes || '')?.canonical || null
}

function getTransactionDay(t) {
  return t?.date ? parseInt(String(t.date).split('-')[2], 10) : 99
}

function findFixedDirectorSalaryRule(value) {
  const canonical = getDirectorCanonicalName(value)
  if (!canonical) return null
  return FIXED_DIRECTOR_SALARY_RULES.find(rule => rule.canonical === canonical) || null
}

function isLikelySalaryInternalTx(t, sourceInternal, targetInternal, preferredDirectorName = '') {
  const sourceRole = resolveInternalRole(sourceInternal)
  const targetRole = resolveInternalRole(targetInternal)
  const directorName = resolveInternalDirectorName(sourceInternal, targetInternal, preferredDirectorName)
  if (!directorName) return false
  if (Number(t?.amount || 0) >= 0) return false
  if (!isCompanyOrJointRole(sourceRole) || targetRole !== 'director') return false

  const absAmt = Math.abs(Number(t?.amount || 0))
  const day = getTransactionDay(t)
  return absAmt >= SALARY_RANGE.min && absAmt <= SALARY_RANGE.max && day <= SALARY_DAY_MAX
}

function scoreDirectorSalaryPattern(t, contact) {
  const sourceInternal = findInternalSource(t?.account)
  if (!sourceInternal) return null

  const directorName = getDirectorCanonicalName(contact)
  if (!isLikelySalaryInternalTx(t, sourceInternal, contact, directorName)) return null

  const fixedRule = findFixedDirectorSalaryRule(directorName)
  if (
    fixedRule &&
    Math.abs(Math.abs(Number(t?.amount || 0)) - fixedRule.amount) < 0.01 &&
    getTransactionDay(t) <= fixedRule.dayMax
  ) {
    return {
      score: 0.18,
      reason: `ตรงรูปแบบเงินเดือน ${formatBaht(fixedRule.amount)} ช่วงวันที่ 1-${fixedRule.dayMax}`,
    }
  }

  return {
    score: 0.08,
    reason: 'ตรงรูปแบบเงินเดือนกรรมการ',
  }
}

function findAccountLabel(raw) {
  if (!raw) return null
  return ACCOUNT_LABELS.find(label => label.match(String(raw))) || null
}

function scoreInternalContactMatch(text, contact) {
  if (!text || !contact) return 0
  const raw = String(text)
  const lower = raw.toLowerCase()
  let score = 0

  if (contact.account_number && raw.includes(contact.account_number)) {
    score = Math.max(score, 400 + String(contact.account_number).length)
  }
  if (contact.name) {
    const name = contact.name.toLowerCase()
    if (lower === name) score = Math.max(score, 300 + name.length)
    else if (lower.includes(name)) score = Math.max(score, 200 + name.length)
  }
  return score
}

function findBestInternalContact(text, excludeName = '') {
  if (!text) return null
  const excluded = normInternalText(excludeName)
  let best = null
  let bestScore = 0

  for (const contact of allContacts) {
    if (contact.type !== 'internal') continue
    if (excluded && normInternalText(contact.name) === excluded) continue
    const score = scoreInternalContactMatch(text, contact)
    if (score > bestScore) {
      best = contact
      bestScore = score
    }
  }
  return best
}

function findInternalAccountByRaw(raw) {
  return findBestInternalContact(raw)
}

function findMappedSharedInternal(raw) {
  const matchedLabel = findAccountLabel(raw)
  if (!matchedLabel) return null
  return {
    type: 'internal',
    name: matchedLabel.display,
    account_number: null,
    synthetic: true,
    role: matchedLabel.key,
  }
}

function findInternalSource(raw) {
  return findInternalAccountByRaw(raw) || findMappedSharedInternal(raw)
}

function findInternalCounterparty(text, excludeName = '') {
  const matched = findBestInternalContact(text, excludeName)
  if (matched) return matched

  const synthetic = findMappedSharedInternal(text)
  if (!synthetic) return null

  const excluded = normInternalText(excludeName)
  if (excluded && normInternalText(synthetic.name) === excluded) return null

  return synthetic
}

function resolveInternalRole(contact) {
  if (!contact) return null
  if (contact.synthetic && contact.role) return contact.role
  const label = findAccountLabel(contact.account_number || '')
  if (label?.key) return label.key
  const normalizedNotes = normInternalText(contact.notes)
  if (normalizedNotes.includes(normInternalText('บัญชีบริษัท'))) return 'company'
  if (normalizedNotes.includes(normInternalText('บัญชีคู่'))) return 'joint'
  if (normalizedNotes.includes(normInternalText('บัญชีกรรมการ')) || normalizedNotes.includes(normInternalText('บัญชีบุคคล'))) {
    return getDirectorCanonicalName(contact) ? 'director' : null
  }
  const normalizedName = normInternalText(contact.name)
  if (normalizedName === normInternalText('บัญชีบริษัท')) return 'company'
  if (normalizedName === normInternalText('บัญชีคู่')) return 'joint'
  return getDirectorCanonicalName(contact) ? 'director' : null
}

function isRecognizedInternalContact(contact) {
  return !!resolveInternalRole(contact)
}

function isCompanyOrJointRole(role) {
  return role === 'company' || role === 'joint'
}

function resolveInternalDirectorName(sourceInternal, targetInternal, preferredName = '') {
  const preferredDirector = getDirectorCanonicalName(preferredName)
  if (preferredDirector) return preferredDirector
  if (resolveInternalRole(targetInternal) === 'director') return getDirectorCanonicalName(targetInternal)
  if (resolveInternalRole(sourceInternal) === 'director') return getDirectorCanonicalName(sourceInternal)
  return null
}

function buildInternalDirection(sourceName, targetName, amount) {
  return amount < 0
    ? `${sourceName} → ${targetName}`
    : `${targetName} → ${sourceName}`
}

function classifyInternalDirection(sourceInternal, targetInternal, amount = -1) {
  const sourceRole = resolveInternalRole(sourceInternal)
  const targetRole = resolveInternalRole(targetInternal)
  if (!sourceRole || !targetRole) return null

  const fromRole = amount < 0 ? sourceRole : targetRole
  const toRole   = amount < 0 ? targetRole : sourceRole

  if (isCompanyOrJointRole(fromRole) && isCompanyOrJointRole(toRole) && fromRole !== toRole) {
    return INTERNAL_TYPE_TRANSFER
  }
  if (isCompanyOrJointRole(fromRole) && toRole === 'director') {
    return INTERNAL_TYPE_OUT
  }
  if (fromRole === 'director' && isCompanyOrJointRole(toRole)) {
    return INTERNAL_TYPE_IN
  }
  if (fromRole === 'director' && toRole === 'director') {
    return INTERNAL_TYPE_OTHER
  }
  return null
}

function displayInternalAccount(raw) {
  return findInternalSource(raw)?.name || displayAccount(raw)
}

function findInternalDirectorCounterparty(text, excludeName = '') {
  const contact = findInternalCounterparty(text, excludeName)
  if (!contact || resolveInternalRole(contact) !== 'director') return null
  return contact
}

function detectInternalTx(rows) {
  const intContacts = allContacts.filter(c => c.type === 'internal')
  const transferTx    = []
  const outToDir      = []
  const inFromDir     = []
  const advanceClears = []
  const dividends     = []
  const salaries      = []
  const others        = []

  const getInternalPerson = (memo, excludeName = '') =>
    findInternalDirectorCounterparty(memo, excludeName)?.name || null

  for (const t of rows) {
    if (t.amount === 0) continue

    const memo   = t.memo || ''
    const rawSourceInternal = findInternalSource(t.account)
    const sourceInternal = isRecognizedInternalContact(rawSourceInternal) ? rawSourceInternal : null
    const maintainedName = getMaintainedName(t)
    const maintainedInternal = getMaintainedInternalContact(t, sourceInternal?.name || '')
    const rawTargetInternal = sourceInternal
      ? ((memo ? findInternalCounterparty(memo, sourceInternal.name || '') : null) || maintainedInternal)
      : maintainedInternal
    const targetInternal = isRecognizedInternalContact(rawTargetInternal) ? rawTargetInternal : null
    const sourceRole = resolveInternalRole(sourceInternal)
    const targetRole = resolveInternalRole(targetInternal)
    const sourceName = sourceInternal?.name || displayInternalAccount(t.account)
    const targetName = targetInternal?.name || maintainedInternal?.name || maintainedName || extractCounterparty(memo) || '?'
    const manualType = normalizeInternalType(t.category)
    const directorName = resolveInternalDirectorName(
      sourceInternal,
      targetInternal,
      getInternalPerson(memo, sourceInternal?.name || '')
    )
    const fallbackDirectorName =
      directorName ||
      getDirectorCanonicalName(maintainedInternal) ||
      getDirectorCanonicalName(maintainedName) ||
      targetName
    const autoType = (sourceInternal && targetInternal)
      ? classifyInternalDirection(sourceInternal, targetInternal, t.amount)
      : null
    const pushOther = () => {
      others.push({ t, direction: buildInternalDirection(sourceName, targetName, t.amount) })
    }

    if (INTERNAL_TYPES.has(manualType)) {
      if (manualType === INTERNAL_TYPE_TRANSFER) {
        transferTx.push(t)
        continue
      }
      if (manualType === INTERNAL_TYPE_OUT) {
        outToDir.push({ t, person: fallbackDirectorName })
        continue
      }
      if (manualType === INTERNAL_TYPE_IN) {
        inFromDir.push({ t, person: fallbackDirectorName })
        continue
      }
      if (manualType === INTERNAL_TYPE_ADVANCE) {
        advanceClears.push({ t, person: fallbackDirectorName })
        continue
      }
      if (manualType === INTERNAL_TYPE_DIVIDEND) {
        dividends.push({ t, person: fallbackDirectorName })
        continue
      }
      if (manualType === INTERNAL_TYPE_SALARY) {
        salaries.push({ t, person: fallbackDirectorName })
        continue
      }
      if (manualType === INTERNAL_TYPE_OTHER) {
        pushOther()
        continue
      }
    }

    if (isLikelySalaryInternalTx(t, sourceInternal, targetInternal, directorName)) {
      salaries.push({ t, person: directorName })
      continue
    }

    if (CHAIYAWAT_CODES.some(k => memo.includes(k))) {
      const fallbackName = getDirectorCanonicalName(intContacts.find(c => c.name.includes('ชัยวัฒน์'))) || 'นายชัยวัฒน์ เทพจันทร์'
      advanceClears.push({ t, person: directorName || fallbackName })
      continue
    }

    if (autoType === INTERNAL_TYPE_TRANSFER) {
      transferTx.push(t)
      continue
    }
    if (autoType === INTERNAL_TYPE_OUT && directorName) {
      outToDir.push({ t, person: directorName })
      continue
    }
    if (autoType === INTERNAL_TYPE_IN && directorName) {
      inFromDir.push({ t, person: directorName })
      continue
    }
    if (sourceInternal && targetInternal) {
      pushOther()
      continue
    }
  }

  return {
    transferItems: transferTx,
    transfers: pairTransfers(transferTx),
    outToDir,
    inFromDir,
    advanceClears,
    dividends,
    salaries,
    others,
  }
}

function pairTransfers(txList) {
  const used   = new Set()
  const result = []
  const sorted = [...txList].sort((a, b) => a.date.localeCompare(b.date))

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue
    const a = sorted[i]
    let matchIdx = -1

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue
      const b = sorted[j]
      const dayDiff = (new Date(b.date) - new Date(a.date)) / 86400000
      if (dayDiff > 3) break
      if (displayInternalAccount(a.account) === displayInternalAccount(b.account)) continue
      if (Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) > 0.01) continue
      matchIdx = j; break
    }

    used.add(i)
    if (matchIdx >= 0) {
      used.add(matchIdx)
      const b    = sorted[matchIdx]
      const from = a.amount < 0 ? a : b
      const to   = a.amount < 0 ? b : a
      result.push({
        date:      from.date,
        direction: `${displayInternalAccount(from.account)} → ${displayInternalAccount(to.account)}`,
        amount:    Math.abs(from.amount),
        status:    'confirmed',
        txId:      String(from.id),
        txIds:     [String(from.id), String(to.id)],
      })
    } else {
      const source = displayInternalAccount(a.account)
      const other = findInternalCounterparty(a.memo || '', source)?.name ||
        getMaintainedInternalContact(a, source)?.name ||
        getMaintainedName(a) ||
        '?'
      result.push({
        date:      a.date,
        direction: a.amount < 0
          ? `${source} → ${other}`
          : `${other} → ${source}`,
        amount:    Math.abs(a.amount),
        status:    'pending',
        txId:      String(a.id),
        txIds:     [String(a.id)],
      })
    }
  }
  return result.sort((a, b) => b.date.localeCompare(a.date))
}

// ---- Save manual type override → transactions.category ----
async function saveInternalType(txId, newType) {
  try {
    const category = normalizeInternalType(newType)
    const { error } = await db.from('transactions').update({ category }).eq('id', txId)
    if (error) throw error
    const tx = allTransactions.find(t => String(t.id) === String(txId))
    if (tx) tx.category = category
    if (typeof renderTransferTab === 'function') renderTransferTab()
  } catch (e) {
    alert('บันทึกไม่สำเร็จ: ' + e.message)
  }
}

function openTypeSelect(cellEl, txId, currentType) {
  const activeType = normalizeInternalType(currentType)
  const opts = INTERNAL_TYPE_OPTIONS
  cellEl.innerHTML = `<select onchange="saveInternalType('${txId}', this.value)"
    onblur="renderTransferTab()"
    class="text-xs border border-indigo-300 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400">
    ${opts.map(o => `<option value="${o}" ${o === activeType ? 'selected' : ''}>${o}</option>`).join('')}
  </select>`
  cellEl.querySelector('select')?.focus()
}
function showSyncToast(msg, type = 'info') {
  const old = document.getElementById('sync-toast')
  if (old) old.remove()
  const bg = { info: 'bg-gray-700', green: 'bg-green-600', red: 'bg-red-500' }[type] || 'bg-gray-700'
  const el = document.createElement('div')
  el.id = 'sync-toast'
  el.className = `fixed bottom-6 left-1/2 -translate-x-1/2 ${bg} text-white text-sm font-medium px-5 py-2.5 rounded-xl shadow-lg z-[100] pointer-events-none`
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => { el.style.transition = 'opacity 0.3s'; el.style.opacity = '0' }, 2700)
  setTimeout(() => el.remove(), 3000)
}
