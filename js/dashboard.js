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

// Contacts lookup: account_number/code → { name, type }
let contactMap  = {}
let allContacts = []

// VAT flags: Set of transaction IDs that are marked as VAT
let vatSet = new Set()

// Auto Sync state
let syncResults       = new Map()   // txId → { status, contact?, score? }
let autoSyncAutoItems   = []        // score > 0.8
let autoSyncReviewItems = []        // score 0.5–0.8

async function initDashboard() {
  await Auth.guard()
  await Promise.all([loadTransactions(), loadMaintainRecords(), loadContactsMap(), loadVatFlags()])
  renderAll(allTransactions)
  setupFilters()
}

// ---- Load contacts from สมุดรายชื่อ & build lookup map ----
async function loadContactsMap() {
  const { data } = await db.from('contacts').select('name, account_number, type')
  allContacts = data || []
  contactMap  = {}
  ;(data || []).forEach(c => {
    if (c.account_number) contactMap[c.account_number] = { name: c.name, type: c.type }
  })
}

// คืน { name, type } จากสมุดรายชื่อหรือ maintain records
function getContactInfo(t) {
  // Priority 1: maintain records (date+amount exact match)
  const maintained = getMaintainedName(t)
  if (maintained) return { name: maintained, type: t.amount > 0 ? 'customer' : 'supplier', source: 'maintain' }
  // Priority 2: contacts by account_number appearing in memo
  if (t.memo) {
    for (const [code, contact] of Object.entries(contactMap)) {
      if (code && t.memo.includes(code)) return { name: contact.name, type: contact.type, source: 'contact' }
    }
  }
  return null
}

// ---- Load VAT flags from transaction_vat table ----
async function loadVatFlags() {
  const { data } = await db.from('transaction_vat').select('transaction_id')
  vatSet = new Set((data || []).map(r => String(r.transaction_id)))
}

// ---- Load maintain records & build lookup maps ----
async function loadMaintainRecords() {
  const [{ data: inc }, { data: exp }] = await Promise.all([
    db.from('income_records').select('id, transaction_date, amount, customer_name, job_name, job_details, account_number, file_url, file_name'),
    db.from('expense_records').select('id, transaction_date, amount, supplier_name, details, account_number, file_url, file_name'),
  ])
  incomeMap = {}; incomeMapByTxId = {}
  ;(inc || []).forEach(r => {
    if (r.transaction_date && r.amount != null)
      incomeMap[`${r.transaction_date}|${r.amount}`] = r
    if (r.transaction_id) incomeMapByTxId[String(r.transaction_id)] = r
  })
  expenseMap = {}; expenseMapByTxId = {}
  ;(exp || []).forEach(r => {
    if (r.transaction_date && r.amount != null)
      expenseMap[`${r.transaction_date}|${r.amount}`] = r
    if (r.transaction_id) expenseMapByTxId[String(r.transaction_id)] = r
  })
}

// คืน maintain record สำหรับ transaction นั้น — ค้นด้วย txId ก่อน fallback date|amount
function getMaintainRecord(t) {
  const txId = String(t.id)
  if (t.amount > 0) return incomeMapByTxId[txId]  || incomeMap[`${t.date}|${t.amount}`]  || null
  if (t.amount < 0) return expenseMapByTxId[txId] || expenseMap[`${t.date}|${Math.abs(t.amount)}`] || null
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
  const income  = rows.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0)
  const expense = rows.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0)
  const balance = income + expense
  setText('card-income',  formatBaht(income))
  setText('card-expense', formatBaht(Math.abs(expense)))
  setText('card-balance', formatBaht(balance))
  setText('card-count',   rows.length.toLocaleString('th-TH'))
  const balEl = document.getElementById('card-balance')
  if (balEl) balEl.className = balance >= 0
    ? 'text-2xl font-bold text-green-600'
    : 'text-2xl font-bold text-red-600'
}

// ---- Monthly Income/Expense Bar Chart ----
function renderIncomeChart(rows) {
  const monthly = {}
  for (const t of rows) {
    const ym = t.date?.substring(0, 7) || 'unknown'
    if (!monthly[ym]) monthly[ym] = { income: 0, expense: 0 }
    if (t.amount > 0) monthly[ym].income  += t.amount
    else              monthly[ym].expense += Math.abs(t.amount)
  }
  const labels  = Object.keys(monthly).sort()
  const income  = labels.map(l => monthly[l].income)
  const expense = labels.map(l => monthly[l].expense)

  const ctx = document.getElementById('chart-monthly')?.getContext('2d')
  if (!ctx) return
  if (chartIncome) chartIncome.destroy()
  chartIncome = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.map(formatYM),
      datasets: [
        { label: 'รายรับ',  data: income,  backgroundColor: '#22c55e' },
        { label: 'รายจ่าย', data: expense, backgroundColor: '#ef4444' }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top' } },
      scales: { y: { ticks: { callback: v => '฿' + v.toLocaleString('th-TH') } } }
    }
  })
}

// ---- Monthly Summary Table ----
function renderMonthlyTable(rows) {
  const el = document.getElementById('monthly-summary-table')
  if (!el) return

  const monthly = {}
  for (const t of rows) {
    const ym = t.date?.substring(0, 7)
    if (!ym) continue
    if (!monthly[ym]) monthly[ym] = { income: 0, expense: 0 }
    if (t.amount > 0) monthly[ym].income  += t.amount
    else              monthly[ym].expense += Math.abs(t.amount)
  }

  const labels = Object.keys(monthly).sort()
  if (!labels.length) { el.innerHTML = ''; return }

  const totalIncome  = labels.reduce((s, l) => s + monthly[l].income,  0)
  const totalExpense = labels.reduce((s, l) => s + monthly[l].expense, 0)
  const totalNet     = totalIncome - totalExpense

  const netClass = (n) => n >= 0 ? 'text-blue-600 font-bold' : 'text-red-600 font-bold'

  const rows_html = labels.map(ym => {
    const { income, expense } = monthly[ym]
    const net = income - expense
    return `<tr class="border-t border-gray-100 hover:bg-gray-50">
      <td class="px-4 py-2.5 text-sm text-gray-700 font-medium">${formatYM(ym)}</td>
      <td class="px-4 py-2.5 text-sm text-green-600 font-semibold text-right">${formatBaht(income)}</td>
      <td class="px-4 py-2.5 text-sm text-orange-500 font-semibold text-right">${formatBaht(expense)}</td>
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
            <th class="px-4 py-3 text-right font-semibold">กำไรเบื้องต้น</th>
          </tr>
        </thead>
        <tbody class="bg-white">
          ${rows_html}
          <tr class="border-t-2 border-gray-300 bg-gray-50">
            <td class="px-4 py-3 text-sm font-bold text-gray-800">รวม</td>
            <td class="px-4 py-3 text-sm font-bold text-green-600 text-right">${formatBaht(totalIncome)}</td>
            <td class="px-4 py-3 text-sm font-bold text-orange-500 text-right">${formatBaht(totalExpense)}</td>
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

  const groups = {}
  for (const t of rows.filter(t => t.amount < 0)) {
    const info = getContactInfo(t)
    if (info?.type === 'internal') continue  // ข้ามรายการโอนภายใน
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

  const customers = {}
  for (const t of rows.filter(t => t.amount > 0)) {
    const info = getContactInfo(t)
    if (info?.type === 'internal') continue  // ข้ามรายการโอนภายใน
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
    const counterparty = info ? info.name : extractCounterparty(t.memo)
    const syncResult   = syncResults.get(String(t.id))
    const badge = info?.type === 'internal'
      ? `<span class="ml-1.5 text-[10px] bg-slate-100 text-slate-500 rounded px-1 py-0.5 font-medium align-middle">ภายใน</span>`
      : info?.source === 'maintain'
        ? `<span class="ml-1.5 text-[10px] bg-indigo-100 text-indigo-500 rounded px-1 py-0.5 font-medium align-middle">M</span>`
        : info?.source === 'contact'
          ? `<span class="ml-1.5 text-[10px] bg-green-100 text-green-600 rounded px-1 py-0.5 font-medium align-middle">สมุด</span>`
          : syncResult?.status === 'auto'
            ? `<span class="ml-1.5 text-[10px] bg-blue-100 text-blue-600 rounded px-1 py-0.5 font-medium align-middle" title="${Math.round((syncResult.score||0)*100)}% match">⚡${Math.round((syncResult.score||0)*100)}%</span>`
            : syncResult?.status === 'review'
              ? `<span class="ml-1.5 text-[10px] bg-amber-100 text-amber-700 rounded px-1 py-0.5 font-medium align-middle" title="${Math.round((syncResult.score||0)*100)}% — ต้องยืนยัน">⚠${Math.round((syncResult.score||0)*100)}%</span>`
              : syncResult?.status === 'unmatched'
                ? `<span class="ml-1.5 text-[10px] bg-red-100 text-red-500 rounded px-1 py-0.5 font-medium align-middle">❌ ไม่พบ</span>`
                : ''
    const nameCell = info
      ? `<span class="text-indigo-700 font-semibold">${esc(counterparty)}</span>${badge}`
      : (syncResult?.status === 'auto' || syncResult?.status === 'review')
        ? `<span class="text-blue-600 font-medium">${esc(syncResult.contact.name)}</span>${badge}`
        : `<span>${esc(counterparty)}</span>${badge}`

    const linkBtn = info?.type !== 'internal'
      ? `<button onclick="openLinkModal('${esc(String(t.id))}')" title="เชื่อมโยง / แก้ไขรายละเอียด"
          class="ml-1.5 text-[10px] bg-yellow-50 text-yellow-600 border border-yellow-200 rounded px-1 py-0.5 hover:bg-yellow-100 transition-colors align-middle whitespace-nowrap">✎ เชื่อม</button>`
      : ''

    const hasMatch = info?.source === 'maintain' || syncResult?.status === 'auto' || syncResult?.status === 'review'
    const resetBtn = (info?.type !== 'internal' && hasMatch)
      ? `<button onclick="resetMatch('${esc(String(t.id))}')" title="รีเซ็ตการจับคู่ เพื่อ Match ใหม่"
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
    if (info?.type === 'internal') {
      vatCell = `<span class="text-gray-200 text-xs">—</span>`
    } else if (canVat) {
      const label = t.amount > 0 ? 'ภาษีขาย' : 'ภาษีซื้อ'
      vatCell = `<label class="flex flex-col items-center gap-0.5 cursor-pointer select-none" title="${label}">
        <input type="checkbox" ${isVat ? 'checked' : ''} onchange="toggleVat('${esc(String(t.id))}')"
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

// ---- Filters ----
function populateContactNameDropdown(type = '') {
  const filtered = type ? allContacts.filter(c => c.type === type) : allContacts
  const names    = [...new Set(filtered.map(c => c.name))].sort()
  populateSelect('filter-contact-name', names)
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
    const f = new FormData(e.target)

    await Promise.all([
      loadTransactions({
        dateFrom: f.get('date-from') || '',
        dateTo:   f.get('date-to')   || '',
        search:   f.get('search')    || '',
      }),
      loadMaintainRecords(),
      loadContactsMap(),
      loadVatFlags(),
    ])

    const rows = applyClientFilter(allTransactions, {
      account:     f.get('account')       || '',
      contactType: f.get('contact-type')  || '',
      contactName: f.get('contact-name')  || '',
    })
    renderAll(rows)
    setText('tx-count', `แสดง ${Math.min(rows.length, 500)} จาก ${rows.length} รายการ`)
  })

  document.getElementById('filter-reset')?.addEventListener('click', async () => {
    document.getElementById('filter-form')?.reset()
    populateContactNameDropdown()
    await Promise.all([loadTransactions(), loadMaintainRecords(), loadContactsMap(), loadVatFlags()])
    renderAll(allTransactions)
    setText('tx-count', `แสดง ${Math.min(allTransactions.length, 500)} จาก ${allTransactions.length} รายการ`)
  })
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

function openLinkModal(txId) {
  linkModalTx = allTransactions.find(t => String(t.id) === String(txId))
  if (!linkModalTx) return

  const t        = linkModalTx
  const isIncome = t.amount > 0
  const key      = isIncome ? `${t.date}|${t.amount}` : `${t.date}|${Math.abs(t.amount)}`
  const existing = isIncome ? incomeMap[key] : expenseMap[key]

  document.getElementById('link-modal-title').textContent =
    isIncome ? 'เชื่อมโยงรายรับ' : 'เชื่อมโยงรายจ่าย'

  const contactType      = isIncome ? 'customer' : 'supplier'
  const filteredContacts = allContacts.filter(c => c.type === contactType)
  const existingName     = existing ? (isIncome ? existing.customer_name : existing.supplier_name) : ''
  const existingDetail   = existing ? (isIncome ? existing.job_name      : existing.details)       : ''
  const existingJobDets  = existing?.job_details || ''
  const amtColor         = isIncome ? 'text-green-600' : 'text-red-500'
  const amtPrefix        = isIncome ? '+' : '-'

  const datalistHtml = `<datalist id="lm-contact-list">
    ${filteredContacts.map(c => `<option value="${esc(c.name)}">`).join('')}
  </datalist>`

  let html = `
    ${datalistHtml}
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
      <label class="block text-xs font-medium text-gray-500 mb-1">
        ${isIncome ? 'ชื่อลูกค้า / คู่ค้า' : 'ชื่อร้านค้า / Supplier'}
        <span class="text-red-400">*</span>
      </label>
      <input id="lm-name" type="text" list="lm-contact-list" value="${esc(existingName)}"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
        placeholder="${isIncome ? 'ชื่อลูกค้า...' : 'ชื่อร้านค้า / Supplier...'}">
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

  const nameInContacts = filteredContacts.some(c => c.name === existingName)
  html += `
    <div class="flex items-center gap-2 pt-1 border-t border-gray-100 mt-2">
      <input type="checkbox" id="lm-save-contact" class="rounded accent-yellow-500"
        ${existingName && !nameInContacts ? 'checked' : ''}>
      <label for="lm-save-contact" class="text-xs text-gray-500 cursor-pointer">
        บันทึกชื่อในสมุดรายชื่อด้วย
      </label>
      <a href="contacts.html" target="_blank"
        class="ml-auto text-xs text-yellow-600 hover:underline whitespace-nowrap">
        เปิดสมุดรายชื่อ ↗
      </a>
    </div>`

  document.getElementById('link-modal-fields').innerHTML = html
  document.getElementById('link-modal').classList.remove('hidden')
  document.body.classList.add('overflow-hidden')
  document.getElementById('lm-name').focus()
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

    const isIncome  = t.amount > 0
    const name      = document.getElementById('lm-name').value.trim()
    if (!name) {
      alert(isIncome ? 'กรุณากรอกชื่อลูกค้า' : 'กรุณากรอกชื่อร้านค้า / Supplier')
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

    const { error } = existing?.id
      ? await db.from(table).update(payload).eq('id', existing.id)
      : await db.from(table).insert(payload)
    if (error) throw error

    if (saveContact) {
      const contactType = isIncome ? 'customer' : 'supplier'
      const exists      = allContacts.find(c => c.name === name && c.type === contactType)
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

function bestContactMatch(memo) {
  if (!memo || !allContacts.length) return null
  const cp = extractCounterparty(memo)
  const cpText = (cp && cp !== '—') ? cp : ''
  let best = null, bestScore = 0
  for (const c of allContacts) {
    if (c.type === 'internal') continue
    const score = Math.max(
      fuzzyScore(memo, c.name),
      cpText ? fuzzyScore(cpText, c.name) : 0
    )
    if (score > bestScore) { bestScore = score; best = c }
  }
  return (best && bestScore >= 0.5) ? { contact: best, score: bestScore } : null
}

async function runAutoSync() {
  const btn = document.getElementById('auto-sync-btn')
  btn.disabled = true
  btn.textContent = '⏳ วิเคราะห์...'
  try {
    await loadContactsMap()
    const matchableContacts = allContacts.filter(c => c.type !== 'internal')
    if (!matchableContacts.length) {
      showSyncToast('ไม่พบ Supplier / Customer ในสมุดรายชื่อ — กรุณาเพิ่มรายชื่อก่อน', 'info')
      return
    }
    const toProcess = currentRows.filter(t => t.amount !== 0 && !getContactInfo(t))
    if (!toProcess.length) {
      showSyncToast('✅ ทุกรายการมีการจับคู่แล้ว', 'green')
      return
    }
    autoSyncAutoItems   = []
    autoSyncReviewItems = []
    const noMatchItems  = []
    for (const t of toProcess) {
      const match = bestContactMatch(t.memo)
      if (!match)               noMatchItems.push({ t })
      else if (match.score > 0.8) autoSyncAutoItems.push({ t, contact: match.contact, score: match.score })
      else                        autoSyncReviewItems.push({ t, contact: match.contact, score: match.score })
    }
    syncResults = new Map()
    for (const { t } of noMatchItems)
      syncResults.set(String(t.id), { status: 'unmatched' })
    for (const { t, contact, score } of autoSyncAutoItems)
      syncResults.set(String(t.id), { status: 'auto', contact, score })
    for (const { t, contact, score } of autoSyncReviewItems)
      syncResults.set(String(t.id), { status: 'review', contact, score })
    renderAutoSyncModal(autoSyncAutoItems, autoSyncReviewItems, noMatchItems)
    renderTable(currentRows)
  } finally {
    btn.disabled = false
    btn.textContent = '⚡ Auto Sync'
  }
}

function renderAutoSyncModal(autoItems, reviewItems, noMatchItems) {
  const total = autoItems.length + reviewItems.length + noMatchItems.length
  const html = `
    <div class="space-y-4">
      <div class="grid grid-cols-3 gap-3">
        <div class="bg-green-50 border border-green-200 rounded-xl p-3 text-center">
          <p class="text-2xl font-bold text-green-600">${autoItems.length}</p>
          <p class="text-xs text-green-700 font-medium mt-0.5">จับคู่อัตโนมัติ</p>
          <p class="text-[10px] text-green-500 opacity-80">&gt;80% — เลือกเพื่อบันทึก</p>
        </div>
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-center">
          <p class="text-2xl font-bold text-amber-600">${reviewItems.length}</p>
          <p class="text-xs text-amber-700 font-medium mt-0.5">รอยืนยัน</p>
          <p class="text-[10px] text-amber-500 opacity-80">50–80% — เลือกเพื่อยืนยัน</p>
        </div>
        <div class="bg-red-50 border border-red-200 rounded-xl p-3 text-center">
          <p class="text-2xl font-bold text-red-500">${noMatchItems.length}</p>
          <p class="text-xs text-red-600 font-medium mt-0.5">ไม่พบ</p>
          <p class="text-[10px] text-red-400 opacity-80">&lt;50% — กรอกด้วยตนเอง</p>
        </div>
      </div>
      <p class="text-xs text-gray-400">วิเคราะห์ ${total} รายการที่ยังไม่ได้จับคู่ จาก ${currentRows.length} รายการที่แสดงอยู่</p>
      ${autoItems.length   ? renderSyncSection(autoItems,   0,                true,  '✅ จับคู่อัตโนมัติ (>80%)') : ''}
      ${reviewItems.length ? renderSyncSection(reviewItems, autoItems.length, false, '⚠ ต้องยืนยัน (50–80%)') : ''}
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
    const { t, contact, score } = item
    const pct = Math.round(score * 100)
    const pctColor = score > 0.8 ? 'text-green-600' : 'text-amber-600'
    const amtHtml = t.amount > 0
      ? `<span class="text-green-600 font-semibold text-xs">+${formatBaht(t.amount)}</span>`
      : `<span class="text-red-500 font-semibold text-xs">${formatBaht(t.amount)}</span>`
    const typeBadge = contact.type === 'customer'
      ? '<span class="text-[9px] bg-blue-100 text-blue-600 rounded px-1 ml-1">ลูกค้า</span>'
      : '<span class="text-[9px] bg-orange-100 text-orange-600 rounded px-1 ml-1">Supplier</span>'
    const memoText = (t.memo || '').slice(0, 70)
    return `<tr class="border-t border-gray-100 hover:bg-gray-50">
      <td class="px-3 py-2"><input type="checkbox" id="sync-cb-${idx}" ${preChecked ? 'checked' : ''}
        class="w-4 h-4 rounded accent-yellow-500 cursor-pointer"></td>
      <td class="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">${formatDate(t.date)}</td>
      <td class="px-3 py-2 text-xs">${amtHtml}</td>
      <td class="px-3 py-2 text-xs text-gray-500 max-w-[280px] truncate" title="${esc(t.memo || '')}">${esc(memoText)}</td>
      <td class="px-3 py-2 text-xs font-semibold text-gray-800">${esc(contact.name)}${typeBadge}</td>
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
      <span class="text-sm font-semibold text-red-600">❌ ไม่พบ (&lt;50%) — กรอกด้วยตนเอง</span>
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
    for (const { t, contact } of toSave) {
      try {
        await saveAutoSyncMatch(t, contact.name, contact.type)
        saved++
      } catch (e) {
        console.error('Auto sync save error:', e)
        errors++
      }
    }
    await Promise.all([loadMaintainRecords(), loadContactsMap()])
    syncResults = new Map()
    autoSyncAutoItems   = []
    autoSyncReviewItems = []
    renderAll(currentRows)
    closeAutoSyncModal()
    showSyncToast(
      errors ? `บันทึก ${saved} รายการ (ข้อผิดพลาด ${errors})` : `✅ บันทึกสำเร็จ ${saved} รายการ`,
      errors ? 'red' : 'green'
    )
  } finally {
    btn.disabled = false
    btn.textContent = 'บันทึกที่เลือก'
  }
}

async function saveAutoSyncMatch(t, contactName) {
  const isIncome = t.amount > 0
  const existing = getMaintainRecord(t)
  if (isIncome) {
    const payload = { customer_name: contactName, transaction_date: t.date, amount: t.amount, transaction_id: t.id }
    const { error } = existing?.id
      ? await db.from('income_records').update(payload).eq('id', existing.id)
      : await db.from('income_records').insert(payload)
    if (error) throw error
  } else {
    const payload = { supplier_name: contactName, transaction_date: t.date, amount: Math.abs(t.amount), transaction_id: t.id }
    const { error } = existing?.id
      ? await db.from('expense_records').update(payload).eq('id', existing.id)
      : await db.from('expense_records').insert(payload)
    if (error) throw error
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

  syncResults.delete(String(txId))
  renderTable(currentRows)
}

// ──────────────────────────────────────────────────────────────────────
// Internal Transaction Detection — โอนระหว่างบัญชี / เงินเดือน / Advance / ปันผล
// ──────────────────────────────────────────────────────────────────────

const SALARY_RANGE    = { min: 13000, max: 17000 }
const SALARY_DAY_MAX  = 12
const CHAIYAWAT_CODES = ['X3006', 'X8624']   // fallback ถ้ายังไม่ setup contacts
const INTERNAL_TYPE_SALARY = '\u0e40\u0e07\u0e34\u0e19\u0e40\u0e14\u0e37\u0e2d\u0e19'
const INTERNAL_TYPES  = new Set(['โอนระหว่างบัญชี', 'โอนออกให้กรรมการ', 'โอนเข้าจากกรรมการ', 'ปันผลกรรมการ', INTERNAL_TYPE_SALARY, 'อื่นๆ'])

function normInternalText(v) {
  return String(v || '').trim().toLowerCase()
}

function findInternalAccountByRaw(raw) {
  if (!raw) return null
  const text = String(raw)
  const lower = text.toLowerCase()
  return allContacts.find(c =>
    c.type === 'internal' && (
      (c.account_number && text.includes(c.account_number)) ||
      (c.name && lower.includes(c.name.toLowerCase()))
    )
  ) || null
}

function findMappedSharedInternal(raw) {
  if (!raw) return null
  const matchedLabel = ACCOUNT_LABELS.find(l => l.match(String(raw)))
  if (!matchedLabel) return null
  return {
    type: 'internal',
    name: matchedLabel.display,
    account_number: null,
    synthetic: true,
  }
}

function findInternalSource(raw) {
  return findInternalAccountByRaw(raw) || findMappedSharedInternal(raw)
}

function findInternalCounterparty(text, excludeName = '') {
  if (!text) return null
  const lower = String(text).toLowerCase()
  const excluded = normInternalText(excludeName)
  return allContacts.find(c => {
    if (c.type !== 'internal') return false
    if (excluded && normInternalText(c.name) === excluded) return false
    return (c.account_number && text.includes(c.account_number))
      || (c.name && lower.includes(c.name.toLowerCase()))
  }) || null
}

function displayInternalAccount(raw) {
  return findInternalSource(raw)?.name || displayAccount(raw)
}

function isMappedSharedInternal(contact) {
  if (!contact) return false
  return ACCOUNT_LABELS.some(l =>
    (contact.account_number && l.match(contact.account_number)) ||
    (contact.name && l.match(contact.name))
  )
}

function findInternalDirectorCounterparty(text, excludeName = '') {
  const contact = findInternalCounterparty(text, excludeName)
  if (!contact) return null
  if (isMappedSharedInternal(contact)) return null
  return contact
}

function detectInternalTx(rows) {
  // ดึง internal contacts จากสมุดรายชื่อ
  const intContacts = allContacts.filter(c => c.type === 'internal')

  const transferTx = []   // raw tx → pairTransfers
  const outToDir   = []   // โอนออกให้กรรมการ  { t, person }
  const inFromDir  = []   // โอนเข้าจากกรรมการ { t, person }
  const dividends  = []   // ปันผลกรรมการ      { t, person }
  const salaries   = []   // เงินเดือน          { t, person }

  const getInternalPerson = (memo, excludeName = '') =>
    findInternalDirectorCounterparty(memo, excludeName)?.name || null

  for (const t of rows) {
    if (!t.memo || t.amount === 0) continue
    const memo   = t.memo
    const absAmt = Math.abs(t.amount)
    const day    = t.date ? parseInt(t.date.split('-')[2]) : 99
    const sourceInternal = findInternalSource(t.account)
    const targetInternal = sourceInternal
      ? findInternalCounterparty(memo, sourceInternal.name || '')
      : null

    // A. Manual override (transactions.category)
    if (INTERNAL_TYPES.has(t.category)) {
      // ถ้าต้นทางและปลายทางอยู่ใน "บัญชีภายใน" ทั้งคู่
      // ให้ถือเป็นโอนระหว่างบัญชีเสมอ ยกเว้นหมวดเฉพาะที่ต้องแยกเอง
      if (sourceInternal && targetInternal && t.category !== INTERNAL_TYPE_SALARY && t.category !== 'ปันผลกรรมการ') {
        transferTx.push(t)
        continue
      }
      const person = getInternalPerson(memo, sourceInternal?.name || '')
      if (t.category === 'โอนระหว่างบัญชี') {
        transferTx.push(t)
      } else if (person) {
        if      (t.category === 'โอนออกให้กรรมการ')  outToDir.push({ t, person })
        else if (t.category === 'โอนเข้าจากกรรมการ') inFromDir.push({ t, person })
        else if (t.category === 'ปันผลกรรมการ')      dividends.push({ t, person })
        else if (t.category === INTERNAL_TYPE_SALARY)  salaries.push({ t, person })
      }
      // 'อื่นๆ' → ไม่แสดง
      continue
    }

    // B. Salary heuristic: outgoing ~15,000 in the first days of month
    if (t.amount < 0 && absAmt >= SALARY_RANGE.min && absAmt <= SALARY_RANGE.max && day <= SALARY_DAY_MAX) {
      const person = getInternalPerson(memo, sourceInternal?.name || '')
      if (person) {
        salaries.push({ t, person })
        continue
      }
    }

    // C. โอนระหว่างบัญชีจะแสดงเฉพาะรายการที่ต้นทางและปลายทางอยู่ใน "บัญชีภายใน"
    if (sourceInternal && targetInternal) {
      transferTx.push(t)
      continue
    }

    // D. Fallback: ชัยวัฒน์ advance X-codes
    if (CHAIYAWAT_CODES.some(k => memo.includes(k))) {
      const name = intContacts.find(c => c.name.includes('ชัยวัฒน์'))?.name || 'ชัยวัฒน์ เทพจันทร์'
      if (t.amount < 0) outToDir.push({ t, person: name })
      else               inFromDir.push({ t, person: name })
      continue
    }
  }

  return { transfers: pairTransfers(transferTx), outToDir, inFromDir, dividends, salaries }
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
      })
    } else {
      const source = displayInternalAccount(a.account)
      const other = findInternalCounterparty(a.memo, source)?.name || '?'
      result.push({
        date:      a.date,
        direction: a.amount < 0
          ? `${source} → ${other}`
          : `${other} → ${source}`,
        amount:    Math.abs(a.amount),
        status:    'pending',
        txId:      String(a.id),
      })
    }
  }
  return result.sort((a, b) => b.date.localeCompare(a.date))
}

// ---- Save manual type override → transactions.category ----
async function saveInternalType(txId, newType) {
  try {
    const { error } = await db.from('transactions').update({ category: newType }).eq('id', txId)
    if (error) throw error
    const tx = allTransactions.find(t => String(t.id) === String(txId))
    if (tx) tx.category = newType
    if (typeof renderTransferTab === 'function') renderTransferTab()
  } catch (e) {
    alert('บันทึกไม่สำเร็จ: ' + e.message)
  }
}

function openTypeSelect(cellEl, txId, currentType) {
  const opts = ['โอนระหว่างบัญชี', 'โอนออกให้กรรมการ', 'โอนเข้าจากกรรมการ', 'ปันผลกรรมการ', INTERNAL_TYPE_SALARY, 'อื่นๆ']
  cellEl.innerHTML = `<select onchange="saveInternalType('${txId}', this.value)"
    onblur="renderTransferTab()"
    class="text-xs border border-indigo-300 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400">
    ${opts.map(o => `<option value="${o}" ${o === currentType ? 'selected' : ''}>${o}</option>`).join('')}
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
