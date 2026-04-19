// ---- Dashboard: Query Supabase + Render ----

let allTransactions = []
let chartIncome, chartCategory

async function initDashboard() {
  await Auth.guard()
  await loadTransactions()
  renderSummaryCards()
  renderIncomeChart()
  renderCategoryChart()
  renderTable(allTransactions)
  setupFilters()
}

async function loadTransactions(filters = {}) {
  let query = db.from('transactions').select('*').order('date', { ascending: false })

  if (filters.account)      query = query.eq('account', filters.account)
  if (filters.dateFrom)     query = query.gte('date', filters.dateFrom)
  if (filters.dateTo)       query = query.lte('date', filters.dateTo)
  if (filters.category)     query = query.eq('category', filters.category)
  if (filters.search)       query = query.ilike('memo', `%${filters.search}%`)

  const { data, error } = await query.limit(2000)
  if (error) { console.error(error); return }

  allTransactions = data || []
}

// ---- Summary Cards ----

function renderSummaryCards() {
  const income  = allTransactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0)
  const expense = allTransactions.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0)
  const balance = income + expense

  setText('card-income',  formatBaht(income))
  setText('card-expense', formatBaht(Math.abs(expense)))
  setText('card-balance', formatBaht(balance))
  setText('card-count',   allTransactions.length.toLocaleString('th-TH'))

  const balEl = document.getElementById('card-balance')
  if (balEl) balEl.className = balance >= 0 ? 'text-2xl font-bold text-green-600' : 'text-2xl font-bold text-red-600'
}

// ---- Monthly Income/Expense Chart ----

function renderIncomeChart() {
  const monthly = {}
  for (const t of allTransactions) {
    const ym = t.date?.substring(0, 7) || 'unknown'
    if (!monthly[ym]) monthly[ym] = { income: 0, expense: 0 }
    if (t.amount > 0) monthly[ym].income  += t.amount
    else              monthly[ym].expense += Math.abs(t.amount)
  }

  const labels = Object.keys(monthly).sort()
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

// ---- Category Pie Chart ----

function renderCategoryChart() {
  const catMap = {}
  for (const t of allTransactions.filter(t => t.amount < 0)) {
    const c = t.category || 'อื่นๆ'
    catMap[c] = (catMap[c] || 0) + Math.abs(t.amount)
  }

  const sorted  = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const labels  = sorted.map(e => e[0])
  const values  = sorted.map(e => e[1])
  const colors  = ['#6366f1','#f59e0b','#ef4444','#10b981','#3b82f6','#ec4899','#8b5cf6','#14b8a6']

  const ctx = document.getElementById('chart-category')?.getContext('2d')
  if (!ctx) return

  if (chartCategory) chartCategory.destroy()
  chartCategory = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors }] },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right' },
        tooltip: { callbacks: { label: c => ` ${formatBaht(c.raw)}` } }
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
    const amtClass = t.amount >= 0 ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'
    return `<tr class="border-t border-gray-100 hover:bg-gray-50 transition-colors">
      <td class="px-4 py-2 text-sm text-gray-600">${formatDate(t.date)}</td>
      <td class="px-4 py-2 text-sm">${t.account || '—'}</td>
      <td class="px-4 py-2 text-sm">${t.category || '—'}</td>
      <td class="px-4 py-2 text-sm text-gray-600 max-w-xs truncate" title="${t.memo || ''}">${t.memo || '—'}</td>
      <td class="px-4 py-2 text-sm ${amtClass} text-right">${formatBaht(t.amount)}</td>
      <td class="px-4 py-2 text-sm text-gray-400">${t.source_file || '—'}</td>
    </tr>`
  }).join('')
}

// ---- Filters ----

function setupFilters() {
  const accounts  = [...new Set(allTransactions.map(t => t.account).filter(Boolean))].sort()
  const categories = [...new Set(allTransactions.map(t => t.category).filter(Boolean))].sort()

  populateSelect('filter-account',  accounts)
  populateSelect('filter-category', categories)

  document.getElementById('filter-form')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    await loadTransactions({
      account:   f.get('account')   || '',
      dateFrom:  f.get('date-from') || '',
      dateTo:    f.get('date-to')   || '',
      category:  f.get('category')  || '',
      search:    f.get('search')    || ''
    })
    renderSummaryCards()
    renderIncomeChart()
    renderCategoryChart()
    renderTable(allTransactions)
  })

  document.getElementById('filter-reset')?.addEventListener('click', async () => {
    document.getElementById('filter-form')?.reset()
    await loadTransactions()
    renderSummaryCards()
    renderIncomeChart()
    renderCategoryChart()
    renderTable(allTransactions)
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
