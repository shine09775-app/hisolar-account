// ---- Dashboard: Query Supabase + Render ----

let allTransactions = []
let chartIncome, chartExpenseGroup, chartIncomeCustomer

async function initDashboard() {
  await Auth.guard()
  await loadTransactions()
  renderAll(allTransactions)
  setupFilters()
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

// ---- Client-side filters: account (display name) + category group ----
function applyClientFilter(rows, { account = '', category = '' } = {}) {
  let result = rows
  if (account)  result = result.filter(t => displayAccount(t.account) === account)
  if (category) result = result.filter(t => resolveCategory(t.memo)   === category)
  return result
}

// ---- Render ทุก section พร้อมกัน ----
function renderAll(rows) {
  renderSummaryCards(rows)
  renderIncomeChart(rows)
  renderMonthlyTable(rows)
  renderExpenseGroupChart(rows)
  renderIncomeCustomerChart(rows)
  renderTable(rows)
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
    const grp = resolveCategory(t.memo)
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
    const name = extractCounterparty(t.memo)
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
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-gray-400">ไม่พบข้อมูล</td></tr>'
    return
  }

  tbody.innerHTML = rows.slice(0, 500).map(t => {
    const counterparty = extractCounterparty(t.memo)
    const income  = t.amount > 0
      ? `<span class="text-green-600 font-semibold">${formatBaht(t.amount)}</span>` : ''
    const expense = t.amount < 0
      ? `<span class="text-red-500 font-semibold">${formatBaht(Math.abs(t.amount))}</span>` : ''
    return `<tr class="border-t border-gray-100 hover:bg-gray-50 transition-colors">
      <td class="px-4 py-2 text-sm text-gray-600 whitespace-nowrap">${formatDate(t.date)}</td>
      <td class="px-4 py-2 text-sm text-gray-700">${displayAccount(t.account)}</td>
      <td class="px-4 py-2 text-sm text-gray-800 font-medium max-w-[180px] truncate" title="${counterparty}">${counterparty}</td>
      <td class="px-4 py-2 text-sm text-gray-500 max-w-xs truncate" title="${t.memo || ''}">${t.memo || '—'}</td>
      <td class="px-4 py-2 text-sm text-right whitespace-nowrap">${income}</td>
      <td class="px-4 py-2 text-sm text-right whitespace-nowrap">${expense}</td>
    </tr>`
  }).join('')
}

// ---- Filters ----
function setupFilters() {
  // dropdown บัญชี: ใช้ชื่อแสดงจาก ACCOUNT_LABELS (ไม่ใช่ค่าดิบจาก DB)
  populateSelect('filter-account',  ACCOUNT_LABELS.map(l => l.display))
  // dropdown หมวดหมู่: กลุ่ม Supplier จาก CATEGORY_MAP (กรองฝั่ง client)
  populateSelect('filter-category', CATEGORY_MAP.map(c => c.group).concat(['อื่นๆ']))

  document.getElementById('filter-form')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)

    // โหลดจาก Supabase: date + search เท่านั้น
    await loadTransactions({
      dateFrom: f.get('date-from') || '',
      dateTo:   f.get('date-to')   || '',
      search:   f.get('search')    || '',
    })

    // กรองฝั่ง client: account + category
    const rows = applyClientFilter(allTransactions, {
      account:  f.get('account')  || '',
      category: f.get('category') || '',
    })
    renderAll(rows)
    setText('tx-count', `แสดง ${Math.min(rows.length, 500)} จาก ${rows.length} รายการ`)
  })

  document.getElementById('filter-reset')?.addEventListener('click', async () => {
    document.getElementById('filter-form')?.reset()
    await loadTransactions()
    renderAll(allTransactions)
    setText('tx-count', `แสดง ${Math.min(allTransactions.length, 500)} จาก ${allTransactions.length} รายการ`)
  })
}

// ---- Helpers ----
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
