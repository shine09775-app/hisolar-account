// ---- Maintain: Income & Expense Records ----

const records = { income: {}, expense: {} }
let currentTab = 'income'
let editingId   = null
let editingType = null

async function initMaintain() {
  await Auth.guard()
  setupTabs()
  await loadRecords('income')
}

// ---- Tab switching ----
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.dataset.tab
      if (tab === currentTab) return
      currentTab = tab

      document.querySelectorAll('.tab-btn').forEach(b => {
        const active = b === btn
        b.classList.toggle('border-yellow-400', active)
        b.classList.toggle('text-yellow-600', active)
        b.classList.toggle('bg-white', active)
        b.classList.toggle('border-transparent', !active)
        b.classList.toggle('text-gray-500', !active)
      })
      document.getElementById('tab-income').classList.toggle('hidden', tab !== 'income')
      document.getElementById('tab-expense').classList.toggle('hidden', tab !== 'expense')

      await loadRecords(tab)
    })
  })
}

// ---- Load & Render ----
async function loadRecords(type) {
  const isIncome = type === 'income'
  const table    = isIncome ? 'income_records' : 'expense_records'
  const cols     = isIncome ? 7 : 6
  const tbodyId  = isIncome ? 'income-tbody' : 'expense-tbody'
  const tbody    = document.getElementById(tbodyId)

  tbody.innerHTML = `<tr><td colspan="${cols}" class="text-center py-10 text-gray-400">กำลังโหลด...</td></tr>`

  const { data, error } = await db.from(table)
    .select('*').order('transaction_date', { ascending: false })

  if (error) {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="text-center py-10 text-red-400">${esc(error.message)}</td></tr>`
    return
  }

  records[type] = {}
  data.forEach(r => { records[type][r.id] = r })

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="text-center py-10 text-gray-400">ยังไม่มีข้อมูล — กด "+ เพิ่มรายการ" เพื่อเริ่มต้น</td></tr>`
    return
  }

  tbody.innerHTML = data.map(r => isIncome ? renderIncomeRow(r) : renderExpenseRow(r)).join('')
}

function renderIncomeRow(r) {
  const fileBtn = r.file_url
    ? `<button onclick="previewFile('${r.id}','income')" class="text-xs text-blue-500 hover:underline whitespace-nowrap">ดูไฟล์</button>`
    : `<span class="text-xs text-gray-300">—</span>`
  return `
    <tr class="border-t border-gray-100 hover:bg-yellow-50/40 transition-colors">
      <td class="px-4 py-3 text-gray-500 whitespace-nowrap">${r.transaction_date || '—'}</td>
      <td class="px-4 py-3 font-medium text-gray-800">${esc(r.customer_name)}</td>
      <td class="px-4 py-3 text-gray-500 font-mono text-xs">${esc(r.account_number || '—')}</td>
      <td class="px-4 py-3 text-gray-600">${esc(r.job_name || '—')}</td>
      <td class="px-4 py-3 text-gray-400 text-sm max-w-[200px] truncate" title="${esc(r.job_details || '')}">${esc(r.job_details || '—')}</td>
      <td class="px-4 py-3 text-right font-semibold text-green-600 whitespace-nowrap">${r.amount != null ? fmtMoney(r.amount) : '—'}</td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-2 justify-end">
          ${fileBtn}
          <button onclick="openModal('income','${r.id}')" class="text-xs text-yellow-600 hover:underline">แก้ไข</button>
          <button onclick="deleteRecord('income','${r.id}')" class="text-xs text-red-400 hover:underline">ลบ</button>
        </div>
      </td>
    </tr>`
}

function renderExpenseRow(r) {
  const fileBtn = r.file_url
    ? `<button onclick="previewFile('${r.id}','expense')" class="text-xs text-blue-500 hover:underline whitespace-nowrap">ดูไฟล์</button>`
    : `<span class="text-xs text-gray-300">—</span>`
  return `
    <tr class="border-t border-gray-100 hover:bg-red-50/40 transition-colors">
      <td class="px-4 py-3 text-gray-500 whitespace-nowrap">${r.transaction_date || '—'}</td>
      <td class="px-4 py-3 font-medium text-gray-800">${esc(r.supplier_name)}</td>
      <td class="px-4 py-3 text-gray-500 font-mono text-xs">${esc(r.account_number || '—')}</td>
      <td class="px-4 py-3 text-gray-400 text-sm max-w-[240px] truncate" title="${esc(r.details || '')}">${esc(r.details || '—')}</td>
      <td class="px-4 py-3 text-right font-semibold text-red-500 whitespace-nowrap">${r.amount != null ? fmtMoney(r.amount) : '—'}</td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-2 justify-end">
          ${fileBtn}
          <button onclick="openModal('expense','${r.id}')" class="text-xs text-yellow-600 hover:underline">แก้ไข</button>
          <button onclick="deleteRecord('expense','${r.id}')" class="text-xs text-red-400 hover:underline">ลบ</button>
        </div>
      </td>
    </tr>`
}

// ---- Modal Open ----
function openModal(type, id = null) {
  editingType = type
  editingId   = id
  const r     = id ? records[type][id] : null

  document.getElementById('modal-title').textContent = r
    ? (type === 'income' ? 'แก้ไขรายได้' : 'แก้ไขรายจ่าย')
    : (type === 'income' ? 'เพิ่มรายได้'  : 'เพิ่มรายจ่าย')

  const fields = document.getElementById('modal-fields')
  fields.innerHTML = type === 'income' ? buildIncomeFields(r) : buildExpenseFields(r)
  fields.innerHTML += buildFileSection(r)

  setupDropZone()
  document.getElementById('modal').classList.remove('hidden')
  document.body.classList.add('overflow-hidden')
}

function buildIncomeFields(r) {
  return `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="md:col-span-2">
        <label class="label">ชื่อลูกค้า <span class="text-red-400">*</span></label>
        <input id="f-customer_name" type="text" value="${esc(r?.customer_name || '')}" class="input" placeholder="ชื่อลูกค้า / ผู้โอน">
      </div>
      <div>
        <label class="label">เลขบัญชีลูกค้า</label>
        <input id="f-account_number" type="text" value="${esc(r?.account_number || '')}" class="input" placeholder="xxx-x-xxxxx-x">
      </div>
      <div>
        <label class="label">วันที่รับเงิน</label>
        <input id="f-transaction_date" type="date" value="${r?.transaction_date || ''}" class="input">
      </div>
      <div>
        <label class="label">ชื่องาน / โปรเจกต์</label>
        <input id="f-job_name" type="text" value="${esc(r?.job_name || '')}" class="input" placeholder="เช่น ติดตั้งโซลาร์เซลล์ บ้านคุณสมชาย">
      </div>
      <div>
        <label class="label">ยอดเงิน (บาท)</label>
        <input id="f-amount" type="number" step="0.01" min="0" value="${r?.amount ?? ''}" class="input" placeholder="0.00">
      </div>
      <div class="md:col-span-2">
        <label class="label">รายละเอียดงาน</label>
        <textarea id="f-job_details" rows="3" class="input resize-none" placeholder="รายละเอียดเพิ่มเติม...">${esc(r?.job_details || '')}</textarea>
      </div>
    </div>`
}

function buildExpenseFields(r) {
  return `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="md:col-span-2">
        <label class="label">ชื่อร้านค้า / Supplier <span class="text-red-400">*</span></label>
        <input id="f-supplier_name" type="text" value="${esc(r?.supplier_name || '')}" class="input" placeholder="ชื่อร้านค้าหรือผู้ขาย">
      </div>
      <div>
        <label class="label">เลขบัญชี</label>
        <input id="f-account_number" type="text" value="${esc(r?.account_number || '')}" class="input" placeholder="xxx-x-xxxxx-x">
      </div>
      <div>
        <label class="label">วันที่จ่าย</label>
        <input id="f-transaction_date" type="date" value="${r?.transaction_date || ''}" class="input">
      </div>
      <div>
        <label class="label">ยอดเงิน (บาท)</label>
        <input id="f-amount" type="number" step="0.01" min="0" value="${r?.amount ?? ''}" class="input" placeholder="0.00">
      </div>
      <div class="md:col-span-2">
        <label class="label">รายละเอียด</label>
        <textarea id="f-details" rows="3" class="input resize-none" placeholder="รายละเอียดสินค้า / บริการ...">${esc(r?.details || '')}</textarea>
      </div>
    </div>`
}

function buildFileSection(r) {
  const existing = r?.file_url ? `
    <div class="flex items-center gap-3 mb-2 p-2 bg-blue-50 rounded-lg text-sm">
      <span class="text-blue-600 flex-1 truncate">📎 ${esc(r.file_name || 'ไฟล์แนบ')}</span>
      <button onclick="previewFile('${r.id}','${editingType}')" class="text-blue-500 hover:underline text-xs">ดูไฟล์</button>
      <label class="flex items-center gap-1 text-gray-500 cursor-pointer text-xs">
        <input type="checkbox" id="f-remove-file" class="rounded accent-red-400"> ลบไฟล์เดิม
      </label>
    </div>` : ''

  return `
    <div class="mt-5">
      <label class="label">แนบไฟล์ (รูปภาพ PNG/JPG หรือ PDF)</label>
      ${existing}
      <div id="drop-zone" class="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-yellow-400 hover:bg-yellow-50/50 transition-colors">
        <div class="text-3xl mb-2">📂</div>
        <p class="text-sm text-gray-500">ลากไฟล์มาวางที่นี่ หรือ <span class="text-yellow-600 font-semibold">คลิกเพื่อเลือกไฟล์</span></p>
        <p class="text-xs text-gray-400 mt-1">PNG, JPG, PDF — ขนาดไม่เกิน 10 MB</p>
        <input id="f-file" type="file" accept="image/png,image/jpeg,application/pdf" class="hidden">
      </div>
      <div id="file-preview-bar" class="hidden mt-2 flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-700">
        <span id="file-preview-name" class="flex-1 truncate"></span>
        <button type="button" onclick="clearFile()" class="text-red-400 hover:text-red-600 font-bold">✕</button>
      </div>
    </div>`
}

// ---- Drop Zone ----
function setupDropZone() {
  const zone  = document.getElementById('drop-zone')
  const input = document.getElementById('f-file')

  zone.addEventListener('click', () => input.click())

  zone.addEventListener('dragover', e => {
    e.preventDefault()
    zone.classList.add('border-yellow-400', 'bg-yellow-50')
  })
  zone.addEventListener('dragleave', () => {
    zone.classList.remove('border-yellow-400', 'bg-yellow-50')
  })
  zone.addEventListener('drop', e => {
    e.preventDefault()
    zone.classList.remove('border-yellow-400', 'bg-yellow-50')
    const file = e.dataTransfer.files[0]
    if (file) { showFilePick(file); setInputFile(input, file) }
  })
  input.addEventListener('change', () => {
    if (input.files[0]) showFilePick(input.files[0])
  })
}

function showFilePick(file) {
  document.getElementById('file-preview-name').textContent = `${file.name}  (${(file.size / 1024).toFixed(0)} KB)`
  document.getElementById('file-preview-bar').classList.remove('hidden')
}

function clearFile() {
  document.getElementById('f-file').value = ''
  document.getElementById('file-preview-bar').classList.add('hidden')
}

function setInputFile(input, file) {
  const dt = new DataTransfer()
  dt.items.add(file)
  input.files = dt.files
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden')
  document.body.classList.remove('overflow-hidden')
  editingId   = null
  editingType = null
}

// ---- Save ----
async function saveRecord() {
  const btn = document.getElementById('btn-save')
  btn.disabled = true
  btn.textContent = 'กำลังบันทึก...'

  try {
    const r = editingId ? records[editingType][editingId] : null

    // File handling
    let fileUrl  = r?.file_url  || null
    let fileName = r?.file_name || null

    if (document.getElementById('f-remove-file')?.checked && fileUrl) {
      await removeFromStorage(fileUrl)
      fileUrl = fileName = null
    }

    const fileInput = document.getElementById('f-file')
    if (fileInput?.files[0]) {
      if (fileUrl) await removeFromStorage(fileUrl)  // replace existing
      const up = await uploadFile(fileInput.files[0])
      if (!up) return
      fileUrl  = up.url
      fileName = up.name
    }

    let payload, table
    if (editingType === 'income') {
      const customerName = document.getElementById('f-customer_name').value.trim()
      if (!customerName) { alert('กรุณากรอกชื่อลูกค้า'); return }
      payload = {
        customer_name:    customerName,
        account_number:   v('f-account_number'),
        job_name:         v('f-job_name'),
        job_details:      v('f-job_details'),
        transaction_date: v('f-transaction_date') || null,
        amount:           parseFloat(document.getElementById('f-amount').value) || null,
        file_url:  fileUrl,
        file_name: fileName,
      }
      table = 'income_records'
    } else {
      const supplierName = document.getElementById('f-supplier_name').value.trim()
      if (!supplierName) { alert('กรุณากรอกชื่อร้านค้า / Supplier'); return }
      payload = {
        supplier_name:    supplierName,
        account_number:   v('f-account_number'),
        details:          v('f-details'),
        transaction_date: v('f-transaction_date') || null,
        amount:           parseFloat(document.getElementById('f-amount').value) || null,
        file_url:  fileUrl,
        file_name: fileName,
      }
      table = 'expense_records'
    }

    const { error } = editingId
      ? await db.from(table).update(payload).eq('id', editingId)
      : await db.from(table).insert(payload)

    if (error) throw error

    closeModal()
    await loadRecords(editingType || currentTab)

  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message)
  } finally {
    btn.disabled = false
    btn.textContent = 'บันทึก'
  }
}

// ---- Delete ----
async function deleteRecord(type, id) {
  if (!confirm('ยืนยันการลบรายการนี้?')) return

  const r = records[type][id]
  if (r?.file_url) await removeFromStorage(r.file_url)

  const table = type === 'income' ? 'income_records' : 'expense_records'
  const { error } = await db.from(table).delete().eq('id', id)
  if (error) { alert('ลบไม่สำเร็จ: ' + error.message); return }

  await loadRecords(type)
}

// ---- File Upload / Delete ----
async function uploadFile(file) {
  if (file.size > 10 * 1024 * 1024) { alert('ไฟล์ขนาดเกิน 10 MB'); return null }
  const ext  = file.name.split('.').pop().toLowerCase()
  const path = `${editingType}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`

  const { error } = await db.storage.from('attachments').upload(path, file)
  if (error) { alert('อัปโหลดไฟล์ไม่สำเร็จ: ' + error.message); return null }

  const { data } = db.storage.from('attachments').getPublicUrl(path)
  return { url: data.publicUrl, name: file.name }
}

async function removeFromStorage(url) {
  const match = url.match(/\/object\/public\/attachments\/(.+)$/)
  if (!match) return
  await db.storage.from('attachments').remove([decodeURIComponent(match[1])])
}

// ---- File Preview Overlay ----
function previewFile(id, type) {
  const r = records[type][id]
  if (!r?.file_url) return

  const isPdf    = (r.file_name || '').toLowerCase().endsWith('.pdf')
  const overlay  = document.getElementById('preview-overlay')
  const content  = document.getElementById('preview-content')

  document.getElementById('preview-title').textContent = r.file_name || 'ดูไฟล์'

  content.innerHTML = isPdf
    ? `<iframe src="${r.file_url}" class="w-full h-full rounded-lg border-0" title="${esc(r.file_name || '')}"></iframe>`
    : `<img src="${r.file_url}" alt="${esc(r.file_name || '')}" class="max-w-full max-h-full object-contain rounded-xl shadow">`

  overlay.classList.remove('hidden')
  document.body.classList.add('overflow-hidden')
}

function closePreview() {
  document.getElementById('preview-overlay').classList.add('hidden')
  document.getElementById('preview-content').innerHTML = ''
  document.body.classList.remove('overflow-hidden')
}

// ---- Utils ----
function v(id) {
  return document.getElementById(id)?.value.trim() || null
}

function fmtMoney(n) {
  return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

document.addEventListener('DOMContentLoaded', initMaintain)
