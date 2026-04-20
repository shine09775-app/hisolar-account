let transferChart = null

function setTransferMeta(text) {
  const el = document.getElementById('transfer-count')
  if (el) el.textContent = text
}

function setTransferRange() {
  const el = document.getElementById('transfer-range')
  if (!el) return
  if (!allTransactions.length) {
    el.textContent = 'ยังไม่มีข้อมูล — กรุณา Upload Statement ก่อน'
    return
  }
  const dates = allTransactions.map(t => t.date).filter(Boolean).sort()
  if (!dates.length) {
    el.textContent = 'ยังไม่มีข้อมูลช่วงวันที่'
    return
  }
  el.textContent = `ข้อมูล ${formatDate(dates[0])} — ${formatDate(dates[dates.length - 1])}`
}

function destroyTransferChart() {
  if (transferChart) {
    transferChart.destroy()
    transferChart = null
  }
}

function renderTransferTab() {
  const tbody = document.getElementById('transfer-tbody')
  if (!tbody) return

  if (!allTransactions.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-10 text-gray-400">ยังไม่มีข้อมูล — กรุณา Upload Statement ก่อน</td></tr>'
    setText('tr-total-pair-to-main', '0.00')
    setText('tr-total-main-to-pair', '0.00')
    setText('tr-total-pending', '0.00')
    setTransferMeta('ยังไม่มีรายการภายใน')
    destroyTransferChart()
    const legend = document.getElementById('tr-legend')
    if (legend) legend.innerHTML = ''
    return
  }

  const { transfers, outToDir, inFromDir, dividends, salaries } = detectInternalTx(allTransactions)

  const TYPE_CFG = {
    'โอนระหว่างบัญชี': { color: 'bg-purple-100 text-purple-700', dot: '#7c3aed' },
    'โอนออกให้กรรมการ': { color: 'bg-pink-100 text-pink-700', dot: '#ec4899' },
    'โอนเข้าจากกรรมการ': { color: 'bg-sky-100 text-sky-700', dot: '#0ea5e9' },
    'ปันผลกรรมการ': { color: 'bg-amber-100 text-amber-700', dot: '#f59e0b' },
    [INTERNAL_TYPE_SALARY]: { color: 'bg-emerald-100 text-emerald-700', dot: '#10b981' },
    'อื่นๆ': { color: 'bg-gray-100 text-gray-500', dot: '#94a3b8' },
  }

  const allRows = [
    ...transfers.map(r => ({ ...r, type: 'โอนระหว่างบัญชี' })),
    ...salaries.map(({ t, person }) => ({
      date: t.date,
      type: INTERNAL_TYPE_SALARY,
      direction: `${displayInternalAccount(t.account)} → ${person}`,
      amount: Math.abs(t.amount),
      status: 'confirmed',
      txId: String(t.id),
    })),
    ...outToDir.map(({ t, person }) => ({
      date: t.date,
      type: INTERNAL_TYPES.has(t.category) ? t.category : 'โอนออกให้กรรมการ',
      direction: `${displayInternalAccount(t.account)} → ${person}`,
      amount: Math.abs(t.amount),
      status: 'confirmed',
      txId: String(t.id),
    })),
    ...inFromDir.map(({ t, person }) => ({
      date: t.date,
      type: INTERNAL_TYPES.has(t.category) ? t.category : 'โอนเข้าจากกรรมการ',
      direction: `${person} → ${displayInternalAccount(t.account)}`,
      amount: Math.abs(t.amount),
      status: 'confirmed',
      txId: String(t.id),
    })),
    ...dividends.map(({ t, person }) => ({
      date: t.date,
      type: INTERNAL_TYPES.has(t.category) ? t.category : 'ปันผลกรรมการ',
      direction: `${displayInternalAccount(t.account)} → ${person}`,
      amount: Math.abs(t.amount),
      status: 'confirmed',
      txId: String(t.id),
    })),
  ].sort((a, b) => b.date.localeCompare(a.date))

  if (!allRows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-10 text-gray-400">ไม่พบรายการภายในที่ตรงเงื่อนไข</td></tr>'
  } else {
    tbody.innerHTML = allRows.map(r => {
      const cfg = TYPE_CFG[r.type] || { color: 'bg-gray-100 text-gray-600' }
      const typeBadge = `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${cfg.color}">${r.type}</span>`
      const editBtn = r.txId
        ? `<button onclick="openTypeSelect(this.closest('td'),'${r.txId}','${r.type}')"
            class="ml-1.5 text-gray-300 hover:text-indigo-500 text-[11px] align-middle transition-colors" title="แก้ไขประเภท">✎</button>`
        : ''
      const isLarge = r.amount >= 1000000
      const amtFmt = Number(r.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })
      const statusBadge = r.status === 'confirmed'
        ? `<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-green-50 text-green-700 border border-green-200">✓ ยืนยัน</span>`
        : `<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-600 border border-amber-300">⚠ รอยืนยัน</span>`
      return `<tr class="border-t border-gray-100 hover:bg-gray-50 transition-colors">
        <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">${formatDate(r.date)}</td>
        <td class="px-4 py-3 whitespace-nowrap">${typeBadge}${editBtn}</td>
        <td class="px-4 py-3 text-sm text-gray-700">${r.direction}</td>
        <td class="px-4 py-3 text-sm text-right font-semibold text-gray-800 whitespace-nowrap ${isLarge ? 'text-base' : ''}">${amtFmt}</td>
        <td class="px-4 py-3 text-center">${statusBadge}</td>
      </tr>`
    }).join('')
  }

  const totalTransfer = transfers.reduce((s, r) => s + r.amount, 0)
  const pendingTransfer = transfers.filter(r => r.status === 'pending').reduce((s, r) => s + r.amount, 0)
  const totalSalary = salaries.reduce((s, { t }) => s + Math.abs(t.amount), 0)
  const totalOut = outToDir.reduce((s, { t }) => s + Math.abs(t.amount), 0) + totalSalary
  const totalIn = inFromDir.reduce((s, { t }) => s + Math.abs(t.amount), 0)
  const totalDividend = dividends.reduce((s, { t }) => s + Math.abs(t.amount), 0)

  const fmt = v => Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2 })
  setText('tr-total-pair-to-main', fmt(totalTransfer))
  setText('tr-total-main-to-pair', fmt(totalOut))
  setText('tr-total-pending', fmt(pendingTransfer))
  setTransferMeta(`พบ ${allRows.length.toLocaleString('th-TH')} รายการภายใน`)

  const chartData = [
    { label: 'โอนระหว่างบัญชี', value: totalTransfer, color: '#7c3aed' },
    { label: 'โอนออกให้กรรมการ / เงินเดือน', value: totalOut, color: '#ec4899' },
    { label: 'โอนเข้าจากกรรมการ', value: totalIn, color: '#0ea5e9' },
    { label: 'ปันผลกรรมการ', value: totalDividend, color: '#f59e0b' },
  ].filter(d => d.value > 0)

  const total = chartData.reduce((s, d) => s + d.value, 0)
  const chartEl = document.getElementById('chart-transfers')
  const legendEl = document.getElementById('tr-legend')
  destroyTransferChart()
  if (chartEl && chartData.length) {
    transferChart = new Chart(chartEl.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: chartData.map(d => d.label),
        datasets: [{ data: chartData.map(d => d.value), backgroundColor: chartData.map(d => d.color), borderWidth: 2, borderColor: '#fff' }],
      },
      options: {
        responsive: true,
        cutout: '65%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => ` ${fmt(c.raw)} บาท (${total ? Math.round(c.raw / total * 100) : 0}%)` } },
        },
      },
    })
  }
  if (legendEl) {
    legendEl.innerHTML = chartData.map(d => {
      const pct = total ? Math.round(d.value / total * 100) : 0
      return `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${d.color}"></span><span>${d.label}</span><span class="ml-auto font-semibold">${pct}%</span></div>`
    }).join('')
  }
}

async function refreshInternalTransfers() {
  const btn = document.getElementById('refresh-internal-btn')
  if (btn) {
    btn.disabled = true
    btn.textContent = 'กำลังโหลด...'
  }
  try {
    await Promise.all([loadTransactions(), loadContactsMap()])
    currentRows = allTransactions
    setTransferRange()
    renderTransferTab()
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = 'รีเฟรช'
    }
  }
}

async function initInternalTransfersPage() {
  if (!await Auth.guard()) return
  await Promise.all([loadTransactions(), loadContactsMap()])
  currentRows = allTransactions
  setTransferRange()
  renderTransferTab()
}

document.addEventListener('DOMContentLoaded', initInternalTransfersPage)
