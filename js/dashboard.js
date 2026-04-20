// ---- Dashboard: Query Supabase + Render ----

let allTransactions = []
let currentRows     = []
let chartIncome, chartExpenseGroup, chartIncomeCustomer

// Maintain lookup maps: key = "YYYY-MM-DD|amount" → full record
let incomeMap  = {}   // amount > 0
let expenseMap = {}   // amount (positive value)

// Contacts lookup: account_number/code → { name, type }
let contactMap  = {}
let allContacts = []

// VAT flags: Set of transaction IDs that are marked as VAT
let vatSet = new Set()

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
  incomeMap = {}
  ;(inc || []).forEach(r => {
    if (r.transaction_date && r.amount != null)
      incomeMap[`${r.transaction_date}|${r.amount}`] = r
  })
  expenseMap = {}
  ;(exp || []).forEach(r => {
    if (r.transaction_date && r.amount != null)
      expenseMap[`${r.transaction_date}|${r.amount}`] = r
  })
}

// คืนชื่อที่ maintain ไว้ (ถ้ามี) สำหรับ transaction นั้น
function getMaintainedName(t) {
  if (t.amount > 0) return incomeMap[`${t.date}|${t.amount}`]?.customer_name || null
  if (t.amount < 0) return expenseMap[`${t.date}|${Math.abs(t.amount)}`]?.supplier_name || null
  return null
}

// คืนรายละเอียดที่ maintain ไว้ (ชื่องาน หรือ รายละเอียดสินค้า)
function getMaintainedDetail(t) {
  if (t.amount > 0) return incomeMap[`${t.date}|${t.amount}`]?.job_name || null
  if (t.amount < 0) return expenseMap[`${t.date}|${Math.abs(t.amount)}`]?.details || null
  return null
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
    const badge = info?.type === 'internal'
      ? `<span class="ml-1.5 text-[10px] bg-slate-100 text-slate-500 rounded px-1 py-0.5 font-medium align-middle">ภายใน</span>`
      : info?.source === 'maintain'
        ? `<span class="ml-1.5 text-[10px] bg-indigo-100 text-indigo-500 rounded px-1 py-0.5 font-medium align-middle">M</span>`
        : info?.source === 'contact'
          ? `<span class="ml-1.5 text-[10px] bg-green-100 text-green-600 rounded px-1 py-0.5 font-medium align-middle">สมุด</span>`
          : ''
    const nameCell = info
      ? `<span class="text-indigo-700 font-semibold">${esc(counterparty)}</span>${badge}`
      : `<span>${esc(counterparty)}</span>`

    const linkBtn = info?.type !== 'internal'
      ? `<button onclick="openLinkModal('${esc(String(t.id))}')" title="เชื่อมโยง / แก้ไขรายละเอียด"
          class="ml-1.5 text-[10px] bg-yellow-50 text-yellow-600 border border-yellow-200 rounded px-1 py-0.5 hover:bg-yellow-100 transition-colors align-middle whitespace-nowrap">✎ เชื่อม</button>`
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
      <td class="px-4 py-2 text-sm max-w-[220px]" title="${esc(counterparty)}">${nameCell}${linkBtn}</td>
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
    const key         = isIncome ? `${t.date}|${t.amount}` : `${t.date}|${Math.abs(t.amount)}`
    const existing    = isIncome ? incomeMap[key] : expenseMap[key]

    let payload, table
    if (isIncome) {
      const jobDetails = document.getElementById('lm-job-details')?.value.trim() || null
      payload = {
        customer_name:    name,
        job_name:         detail   || null,
        job_details:      jobDetails,
        transaction_date: t.date,
        amount:           t.amount,
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
