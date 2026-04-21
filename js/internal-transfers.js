let transferChart = null

function setTransferMeta(text) {
  const el = document.getElementById('transfer-count')
  if (el) el.textContent = text
}

function setTransferRange() {
  const el = document.getElementById('transfer-range')
  if (!el) return
  if (!allTransactions.length) {
    el.textContent = 'ยังไม่มีข้อมูล กรุณา Upload Statement ก่อน'
    return
  }
  const dates = allTransactions.map(t => t.date).filter(Boolean).sort()
  if (!dates.length) {
    el.textContent = 'ยังไม่มีข้อมูลช่วงวันที่'
    return
  }
  el.textContent = `ข้อมูล ${formatDate(dates[0])} — ${formatDate(dates[dates.length - 1])}`
}

function setTransferChartTitle() {
  const titleEl = document.querySelector('#chart-transfers')?.previousElementSibling
  if (titleEl) {
    titleEl.textContent = 'Waterfall กระแสเงินเข้า/ออกบัญชีบริษัทและบัญชีคู่'
  }
}

function destroyTransferChart() {
  if (transferChart) {
    transferChart.destroy()
    transferChart = null
  }
}

function resolveTransferRowType(txCategory, fallback) {
  const normalized = normalizeInternalType(txCategory)
  return INTERNAL_TYPES.has(normalized) ? normalized : fallback
}

function buildInternalFlowSnapshot(t, preferredName = '') {
  const memo = String(t?.memo || '')
  const rawSourceInternal = findInternalSource(t?.account)
  const sourceInternal = isRecognizedInternalContact(rawSourceInternal) ? rawSourceInternal : null
  const maintainedInternal = getMaintainedInternalContact(t, sourceInternal?.name || '')
  const rawTargetInternal = sourceInternal
    ? ((memo ? findInternalCounterparty(memo, sourceInternal.name || '') : null) || maintainedInternal)
    : maintainedInternal
  const targetInternal = isRecognizedInternalContact(rawTargetInternal) ? rawTargetInternal : null

  const sourceRole = resolveInternalRole(sourceInternal)
  const targetRole = resolveInternalRole(targetInternal)
  const sourceName = sourceInternal?.name || displayInternalAccount(t?.account)
  const targetName = targetInternal?.name || maintainedInternal?.name || preferredName || getMaintainedName(t) || extractCounterparty(memo) || '?'
  const fromName = Number(t?.amount || 0) < 0 ? sourceName : targetName
  const toName = Number(t?.amount || 0) < 0 ? targetName : sourceName
  const fromRole = Number(t?.amount || 0) < 0 ? sourceRole : targetRole
  const toRole = Number(t?.amount || 0) < 0 ? targetRole : sourceRole

  return {
    sourceInternal,
    targetInternal,
    sourceRole,
    targetRole,
    fromRole,
    toRole,
    sourceName,
    targetName,
    fromName,
    toName,
    direction: `${fromName} → ${toName}`,
  }
}

function resolveCoreSignedAmount(type, t, flow, zeroTransfer = true) {
  const rawAmount = Number(t?.amount || 0)
  const absAmt = Math.abs(Number(t?.amount || 0))
  if (!absAmt) return 0

  if (type === INTERNAL_TYPE_TRANSFER) {
    if (zeroTransfer) return 0

    if (flow.fromRole === 'company' && flow.toRole === 'joint') return -absAmt
    if (flow.fromRole === 'joint' && flow.toRole === 'company') return absAmt

    // Fallback from the statement account perspective:
    // company account keeps the original sign, joint account flips the sign
    // so the summary always reads as movement from the company's viewpoint.
    if (flow.sourceRole === 'company') return rawAmount
    if (flow.sourceRole === 'joint') return -rawAmount

    return rawAmount
  }
  if (type === INTERNAL_TYPE_OUT || type === INTERNAL_TYPE_SALARY || type === INTERNAL_TYPE_DIVIDEND) return -absAmt
  if (type === INTERNAL_TYPE_IN) return absAmt

  if (isCompanyOrJointRole(flow.fromRole) && isCompanyOrJointRole(flow.toRole)) return 0
  if (flow.fromRole === 'director' && isCompanyOrJointRole(flow.toRole)) return absAmt
  if (isCompanyOrJointRole(flow.fromRole) && flow.toRole === 'director') return -absAmt

  // Fallback: if we only know the role of the statement account, keep the
  // signed amount from the perspective of company/joint so summary cards move
  // with manual type changes even when target role cannot be resolved.
  if (isCompanyOrJointRole(flow.sourceRole)) return rawAmount
  if (flow.sourceRole === 'director') return -rawAmount

  return 0
}

function buildTransferRow(t, fallbackType, preferredName = '', fallbackDirection = '', options = {}) {
  const type = resolveTransferRowType(t?.category, fallbackType)
  const flow = buildInternalFlowSnapshot(t, preferredName)
  return {
    date: t.date,
    type,
    direction: flow.direction.includes('?') && fallbackDirection ? fallbackDirection : flow.direction,
    amount: Math.abs(Number(t.amount || 0)),
    signedAmount: resolveCoreSignedAmount(type, t, flow, options.zeroTransfer ?? true),
    status: 'confirmed',
    txId: String(t.id),
  }
}

function buildTransferWaterfallPoints(rows) {
  const daily = new Map()

  for (const row of rows) {
    const signed = Number(row?.signedAmount || 0)
    if (!signed || !row?.date) continue

    const entry = daily.get(row.date) || {
      date: row.date,
      delta: 0,
      inflow: 0,
      outflow: 0,
      count: 0,
    }

    entry.delta += signed
    if (signed > 0) entry.inflow += signed
    else entry.outflow += Math.abs(signed)
    entry.count += 1
    daily.set(row.date, entry)
  }

  const dates = [...daily.keys()].sort()
  let running = 0
  return dates.map(date => {
    const entry = daily.get(date)
    const start = running
    const end = running + entry.delta
    running = end
    return { ...entry, start, end }
  })
}

function renderTransferLegend(points) {
  const legendEl = document.getElementById('tr-legend')
  if (!legendEl) return

  if (!points.length) {
    legendEl.innerHTML = '<p class="text-xs text-gray-400">ไม่มีรายการที่มีผลสุทธิต่อบัญชีบริษัท/บัญชีคู่ในช่วงนี้</p>'
    return
  }

  const fmt = value => Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2 })
  const fmtSigned = value => `${value >= 0 ? '+' : '-'}${fmt(Math.abs(value))}`
  const totalIn = points.reduce((sum, point) => sum + point.inflow, 0)
  const totalOut = points.reduce((sum, point) => sum + point.outflow, 0)
  const net = points[points.length - 1]?.end || 0

  legendEl.innerHTML = [
    `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-emerald-500 flex-shrink-0"></span><span>เงินเข้า บัญชีบริษัท/บัญชีคู่</span><span class="ml-auto font-semibold text-emerald-600">+${fmt(totalIn)}</span></div>`,
    `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-rose-500 flex-shrink-0"></span><span>เงินออก บัญชีบริษัท/บัญชีคู่</span><span class="ml-auto font-semibold text-rose-600">-${fmt(totalOut)}</span></div>`,
    `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-indigo-500 flex-shrink-0"></span><span>ยอดสะสมสุทธิ</span><span class="ml-auto font-semibold text-indigo-600">${fmtSigned(net)}</span></div>`,
    '<div class="pt-2 text-[11px] text-gray-400">หมายเหตุ: รายการโอนระหว่างบัญชีบริษัท ↔ บัญชีคู่ ไม่นับในกราฟนี้ เพราะยอดสุทธิรวมกันเป็น 0</div>',
  ].join('')
}

function renderTransferTypeSummary(summaryRows, typeCfg) {
  const el = document.getElementById('tr-summary-grid')
  if (!el) return

  const fmt = value => Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2 })
  const fmtSigned = value => `${value >= 0 ? '+' : '-'}${fmt(Math.abs(value))}`

  const cards = INTERNAL_TYPE_OPTIONS.map(type => {
    const rows = summaryRows.filter(row => row.type === type)
    const inflow = rows.reduce((sum, row) => sum + (row.signedAmount > 0 ? row.signedAmount : 0), 0)
    const outflow = rows.reduce((sum, row) => sum + (row.signedAmount < 0 ? Math.abs(row.signedAmount) : 0), 0)
    const net = inflow - outflow
    const count = rows.length
    const cfg = typeCfg[type] || typeCfg[INTERNAL_TYPE_OTHER]
    const valueClass = net > 0
      ? 'text-emerald-600'
      : net < 0
        ? 'text-rose-600'
        : 'text-gray-500'

    return `<div class="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
      <div class="flex items-center justify-between gap-2">
        <span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${cfg.color}">${type}</span>
        <span class="text-[10px] text-gray-400">${count.toLocaleString('th-TH')} รายการ</span>
      </div>
      <div class="mt-2 text-2xl font-bold ${valueClass}">${fmtSigned(net)}</div>
      <div class="mt-1 text-[11px] text-gray-400">สุทธิจากเงินเข้า/ออก บัญชีบริษัทหรือบัญชีคู่</div>
      <div class="mt-2 flex items-center justify-between gap-3 text-[11px]">
        <span class="text-emerald-600">เข้า +${fmt(inflow)}</span>
        <span class="text-rose-600">ออก -${fmt(outflow)}</span>
      </div>
    </div>`
  })

  el.innerHTML = cards.join('')
}

function renderTransferTab() {
  const tbody = document.getElementById('transfer-tbody')
  if (!tbody) return

  setTransferChartTitle()

  if (!allTransactions.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-10 text-gray-400">ยังไม่มีข้อมูล กรุณา Upload Statement ก่อน</td></tr>'
    setTransferMeta('ยังไม่มีรายการภายใน')
    destroyTransferChart()
    renderTransferLegend([])
    renderTransferTypeSummary([], {
      [INTERNAL_TYPE_TRANSFER]: { color: 'bg-purple-100 text-purple-700' },
      [INTERNAL_TYPE_OUT]: { color: 'bg-pink-100 text-pink-700' },
      [INTERNAL_TYPE_IN]: { color: 'bg-sky-100 text-sky-700' },
      [INTERNAL_TYPE_ADVANCE]: { color: 'bg-rose-100 text-rose-700' },
      [INTERNAL_TYPE_DIVIDEND]: { color: 'bg-blue-100 text-blue-700' },
      [INTERNAL_TYPE_SALARY]: { color: 'bg-emerald-100 text-emerald-700' },
      [INTERNAL_TYPE_OTHER]: { color: 'bg-gray-100 text-gray-600' },
    })
    return
  }

  const { transferItems, transfers, outToDir, inFromDir, advanceClears, dividends, salaries, others } = detectInternalTx(allTransactions)

  const TYPE_CFG = {
    [INTERNAL_TYPE_TRANSFER]: { color: 'bg-purple-100 text-purple-700' },
    [INTERNAL_TYPE_OUT]: { color: 'bg-pink-100 text-pink-700' },
    [INTERNAL_TYPE_IN]: { color: 'bg-sky-100 text-sky-700' },
    [INTERNAL_TYPE_ADVANCE]: { color: 'bg-rose-100 text-rose-700' },
    [INTERNAL_TYPE_DIVIDEND]: { color: 'bg-blue-100 text-blue-700' },
    [INTERNAL_TYPE_SALARY]: { color: 'bg-emerald-100 text-emerald-700' },
    [INTERNAL_TYPE_OTHER]: { color: 'bg-gray-100 text-gray-600' },
  }

  const allRows = [
    ...transfers.map(r => ({ ...r, type: INTERNAL_TYPE_TRANSFER, signedAmount: 0 })),
    ...salaries.map(({ t, person }) => buildTransferRow(t, INTERNAL_TYPE_SALARY, person)),
    ...outToDir.map(({ t, person }) => buildTransferRow(t, INTERNAL_TYPE_OUT, person)),
    ...inFromDir.map(({ t, person }) => buildTransferRow(t, INTERNAL_TYPE_IN, person)),
    ...advanceClears.map(({ t, person }) => buildTransferRow(t, INTERNAL_TYPE_ADVANCE, person)),
    ...dividends.map(({ t, person }) => buildTransferRow(t, INTERNAL_TYPE_DIVIDEND, person)),
    ...others.map(({ t, direction }) => buildTransferRow(t, INTERNAL_TYPE_OTHER, '', direction)),
  ].sort((a, b) => b.date.localeCompare(a.date))

  const summaryRows = [
    ...transferItems.map(t => buildTransferRow(t, INTERNAL_TYPE_TRANSFER, '', '', { zeroTransfer: false })),
    ...salaries.map(({ t, person }) => buildTransferRow(t, INTERNAL_TYPE_SALARY, person)),
    ...outToDir.map(({ t, person }) => buildTransferRow(t, INTERNAL_TYPE_OUT, person)),
    ...inFromDir.map(({ t, person }) => buildTransferRow(t, INTERNAL_TYPE_IN, person)),
    ...advanceClears.map(({ t, person }) => buildTransferRow(t, INTERNAL_TYPE_ADVANCE, person)),
    ...dividends.map(({ t, person }) => buildTransferRow(t, INTERNAL_TYPE_DIVIDEND, person)),
    ...others.map(({ t, direction }) => buildTransferRow(t, INTERNAL_TYPE_OTHER, '', direction)),
  ]

  if (!allRows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-10 text-gray-400">ไม่พบรายการภายในที่ตรงเงื่อนไข</td></tr>'
  } else {
    tbody.innerHTML = allRows.map(row => {
      const cfg = TYPE_CFG[row.type] || TYPE_CFG[INTERNAL_TYPE_OTHER]
      const typeBadge = `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${cfg.color}">${row.type}</span>`
      const editBtn = row.txId
        ? `<button onclick="openTypeSelect(this.closest('td'),'${row.txId}','${row.type}')"
            class="ml-1.5 text-gray-300 hover:text-indigo-500 text-[11px] align-middle transition-colors" title="แก้ไขประเภท">✎</button>`
        : ''
      const amtFmt = Number(row.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })
      const statusBadge = row.status === 'confirmed'
        ? '<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-green-50 text-green-700 border border-green-200">✓ ยืนยัน</span>'
        : '<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-600 border border-amber-300">⚠ รอยืนยัน</span>'
      return `<tr class="border-t border-gray-100 hover:bg-gray-50 transition-colors">
        <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">${formatDate(row.date)}</td>
        <td class="px-4 py-3 whitespace-nowrap">${typeBadge}${editBtn}</td>
        <td class="px-4 py-3 text-sm text-gray-700">${row.direction}</td>
        <td class="px-4 py-3 text-sm text-right font-semibold text-gray-800 whitespace-nowrap">${amtFmt}</td>
        <td class="px-4 py-3 text-center">${statusBadge}</td>
      </tr>`
    }).join('')
  }

  setTransferMeta(`พบ ${allRows.length.toLocaleString('th-TH')} รายการภายใน`)
  renderTransferTypeSummary(summaryRows, TYPE_CFG)

  const points = buildTransferWaterfallPoints(allRows)
  const chartEl = document.getElementById('chart-transfers')
  destroyTransferChart()

  if (chartEl && points.length) {
    const positiveData = points.map(point => point.delta > 0 ? [point.start, point.end] : null)
    const negativeData = points.map(point => point.delta < 0 ? [point.start, point.end] : null)
    const cumulativeData = points.map(point => point.end)
    const fmtSigned = value => `${value >= 0 ? '+' : '-'}${fmt(Math.abs(value))}`

    transferChart = new Chart(chartEl.getContext('2d'), {
      type: 'bar',
      data: {
        labels: points.map(point => formatDate(point.date)),
        datasets: [
          {
            label: 'เงินเข้า',
            data: positiveData,
            backgroundColor: '#10b981',
            borderRadius: 8,
            borderSkipped: false,
            barPercentage: 0.72,
            categoryPercentage: 0.86,
          },
          {
            label: 'เงินออก',
            data: negativeData,
            backgroundColor: '#f43f5e',
            borderRadius: 8,
            borderSkipped: false,
            barPercentage: 0.72,
            categoryPercentage: 0.86,
          },
          {
            type: 'line',
            label: 'ยอดสะสม',
            data: cumulativeData,
            borderColor: '#4f46e5',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 4,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title(items) {
                const point = points[items[0]?.dataIndex]
                return point ? formatDate(point.date) : ''
              },
              label(context) {
                const point = points[context.dataIndex]
                if (!point) return ''
                if (context.dataset.type === 'line') {
                  return `ยอดสะสม: ${fmtSigned(point.end)} บาท`
                }
                if (point.delta > 0 && context.dataset.label === 'เงินเข้า') {
                  return `เงินเข้าสุทธิ: +${fmt(point.delta)} บาท`
                }
                if (point.delta < 0 && context.dataset.label === 'เงินออก') {
                  return `เงินออกสุทธิ: -${fmt(Math.abs(point.delta))} บาท`
                }
                return null
              },
              afterBody(items) {
                const point = points[items[0]?.dataIndex]
                if (!point) return []
                return [
                  `เงินเข้า: +${fmt(point.inflow)} บาท`,
                  `เงินออก: -${fmt(point.outflow)} บาท`,
                  `ยอดสะสม: ${fmtSigned(point.end)} บาท`,
                ]
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              autoSkip: true,
              maxTicksLimit: 9,
              maxRotation: 0,
              minRotation: 0,
            },
          },
          y: {
            ticks: {
              callback(value) {
                const num = Number(value || 0)
                return `${num < 0 ? '-' : ''}฿${Math.abs(num).toLocaleString('th-TH')}`
              },
            },
          },
        },
      },
    })
  }

  renderTransferLegend(points)
}

async function refreshInternalTransfers() {
  const btn = document.getElementById('refresh-internal-btn')
  if (btn) {
    btn.disabled = true
    btn.textContent = 'กำลังโหลด...'
  }
  try {
    await Promise.all([loadTransactions(), loadContactsMap(), loadMaintainRecords()])
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
  await Promise.all([loadTransactions(), loadContactsMap(), loadMaintainRecords()])
  currentRows = allTransactions
  setTransferRange()
  renderTransferTab()
}

document.addEventListener('DOMContentLoaded', initInternalTransfersPage)
