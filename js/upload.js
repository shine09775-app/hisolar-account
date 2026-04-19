// ---- Upload Logic + Upsert to Supabase ----

const BATCH_SIZE = 200  // insert ทีละกี่ rows

async function handleUpload(file, accountOverride) {
  setStatus('parsing', `กำลังอ่านไฟล์ ${file.name}...`)

  let rows
  try {
    rows = await parseFile(file, accountOverride)
  } catch (e) {
    setStatus('error', `อ่านไฟล์ไม่ได้: ${e.message}`)
    return
  }

  if (!rows.length) {
    setStatus('error', 'ไม่พบข้อมูลในไฟล์ (ตรวจสอบ header row)')
    return
  }

  setStatus('uploading', `พบ ${rows.length} รายการ — กำลัง upload...`)

  const result = await upsertBatches(rows, file.name, accountOverride)

  logUpload(file.name, accountOverride, rows.length, result.inserted, result.skipped)

  setStatus('success',
    `✓ สำเร็จ — เพิ่มใหม่ ${result.inserted} รายการ, ข้ามซ้ำ ${result.skipped} รายการ`
  )

  renderPreview(result.sample)
}

async function upsertBatches(rows, filename, account) {
  let inserted = 0
  let skipped = 0
  const sample = []

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map(r => ({ ...r, source_file: filename }))

    const { data, error } = await db
      .from('transactions')
      .upsert(batch, {
        onConflict: 'hash',
        ignoreDuplicates: true
      })
      .select('id')

    if (error) {
      console.error('upsert error', error)
      setStatus('error', `Upload ผิดพลาด: ${error.message}`)
      return { inserted, skipped, sample }
    }

    const batchInserted = data ? data.length : 0
    inserted += batchInserted
    skipped  += batch.length - batchInserted

    updateProgress(i + batch.length, rows.length)

    if (sample.length < 5) sample.push(...batch.slice(0, 5 - sample.length))
  }

  return { inserted, skipped, sample }
}

async function logUpload(filename, account, total, inserted, skipped) {
  await db.from('upload_logs').insert({
    filename,
    account,
    rows_total:    total,
    rows_inserted: inserted,
    rows_skipped:  skipped
  })
}

// ---- UI helpers ----

function setStatus(type, message) {
  const el = document.getElementById('upload-status')
  if (!el) return
  const colors = {
    parsing:  'text-blue-600',
    uploading:'text-yellow-600',
    success:  'text-green-600',
    error:    'text-red-600'
  }
  el.className = `mt-4 text-sm font-medium ${colors[type] || ''}`
  el.textContent = message
}

function updateProgress(done, total) {
  const bar = document.getElementById('progress-bar')
  const label = document.getElementById('progress-label')
  if (!bar) return
  const pct = Math.round((done / total) * 100)
  bar.style.width = `${pct}%`
  if (label) label.textContent = `${done} / ${total}`
}

function renderPreview(rows) {
  const el = document.getElementById('preview-table')
  if (!el || !rows.length) return

  const cols = ['date', 'account', 'amount', 'category', 'memo']
  const head = cols.map(c => `<th class="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">${c}</th>`).join('')
  const body = rows.map(r => {
    const amtColor = r.amount >= 0 ? 'text-green-600' : 'text-red-600'
    const cells = cols.map(c => {
      if (c === 'amount') return `<td class="px-3 py-2 ${amtColor} font-medium">${Number(r.amount).toLocaleString('th-TH', {minimumFractionDigits:2})}</td>`
      return `<td class="px-3 py-2 text-gray-700 truncate max-w-xs">${r[c] || '—'}</td>`
    }).join('')
    return `<tr class="border-t border-gray-100">${cells}</tr>`
  }).join('')

  el.innerHTML = `
    <div class="mt-6">
      <p class="text-sm text-gray-500 mb-2">ตัวอย่างข้อมูล (5 รายการแรก)</p>
      <div class="overflow-x-auto rounded-lg border border-gray-200">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50"><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`
}
