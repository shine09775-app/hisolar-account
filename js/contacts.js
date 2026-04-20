// ---- สมุดรายชื่อ: Customers, Suppliers & Internal Accounts ----

let contactRecords = { customer: {}, supplier: {}, internal: {} }
let currentTab = 'customer'
let editingId  = null

async function initContacts() {
  await Auth.guard()
  setupTabs()
  await loadContacts('customer')
}

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
      document.getElementById('tab-customer').classList.toggle('hidden', tab !== 'customer')
      document.getElementById('tab-supplier').classList.toggle('hidden', tab !== 'supplier')
      document.getElementById('tab-internal').classList.toggle('hidden', tab !== 'internal')
      await loadContacts(tab)
    })
  })
}

async function loadContacts(type) {
  const isInternal = type === 'internal'
  const cols    = isInternal ? 4 : 6
  const tbodyId = `${type}-tbody`
  const tbody   = document.getElementById(tbodyId)
  tbody.innerHTML = `<tr><td colspan="${cols}" class="text-center py-10 text-gray-400">กำลังโหลด...</td></tr>`

  const { data, error } = await db.from('contacts')
    .select('*').eq('type', type).order('name')

  if (error) {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="text-center py-10 text-red-400">${esc(error.message)}</td></tr>`
    return
  }

  contactRecords[type] = {}
  data.forEach(r => { contactRecords[type][r.id] = r })

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="text-center py-10 text-gray-400">ยังไม่มีข้อมูล — กด "+ เพิ่มรายชื่อ" เพื่อเริ่มต้น</td></tr>`
    return
  }

  tbody.innerHTML = data.map(r => isInternal
    ? `<tr class="border-t border-gray-100 hover:bg-slate-50 transition-colors">
        <td class="px-4 py-3 font-medium text-gray-800">${esc(r.name)}</td>
        <td class="px-4 py-3 text-gray-500 font-mono text-xs">${esc(r.account_number || '—')}</td>
        <td class="px-4 py-3 text-gray-400 text-sm max-w-[240px] truncate" title="${esc(r.notes || '')}">${esc(r.notes || '—')}</td>
        <td class="px-4 py-3">
          <div class="flex items-center gap-2 justify-end">
            <button onclick="openModal('${r.id}')" class="text-xs text-yellow-600 hover:underline">แก้ไข</button>
            <button onclick="deleteContact('${r.id}')" class="text-xs text-red-400 hover:underline">ลบ</button>
          </div>
        </td>
      </tr>`
    : `<tr class="border-t border-gray-100 hover:bg-gray-50 transition-colors">
        <td class="px-4 py-3 font-medium text-gray-800">${esc(r.name)}</td>
        <td class="px-4 py-3 text-gray-500 font-mono text-xs">${esc(r.account_number || '—')}</td>
        <td class="px-4 py-3 text-gray-500 text-sm">${esc(r.phone || '—')}</td>
        <td class="px-4 py-3 text-gray-500 text-sm">${esc(r.email || '—')}</td>
        <td class="px-4 py-3 text-gray-400 text-sm max-w-[180px] truncate" title="${esc(r.notes || '')}">${esc(r.notes || '—')}</td>
        <td class="px-4 py-3">
          <div class="flex items-center gap-2 justify-end">
            <button onclick="openModal('${r.id}')" class="text-xs text-yellow-600 hover:underline">แก้ไข</button>
            <button onclick="deleteContact('${r.id}')" class="text-xs text-red-400 hover:underline">ลบ</button>
          </div>
        </td>
      </tr>`
  ).join('')
}

function openModal(id = null) {
  editingId = id
  const r   = id ? (contactRecords[currentTab]?.[id] || contactRecords['customer']?.[id] || contactRecords['supplier']?.[id]) : null

  document.getElementById('modal-title').textContent = r ? 'แก้ไขรายชื่อ' : 'เพิ่มรายชื่อ'

  const isInternal = (r?.type || currentTab) === 'internal'

  document.getElementById('modal-fields').innerHTML = `
    <div class="grid grid-cols-1 gap-4">
      <div>
        <label class="label">ประเภท <span class="text-red-400">*</span></label>
        <select id="f-type" class="input" onchange="onTypeChange(this.value)">
          <option value="customer" ${(!r || r.type === 'customer') ? 'selected' : ''}>👤 ลูกค้า</option>
          <option value="supplier" ${r?.type === 'supplier' ? 'selected' : ''}>🏪 ผู้จำหน่าย</option>
          <option value="internal" ${r?.type === 'internal' ? 'selected' : ''}>🏦 บัญชีภายใน</option>
        </select>
      </div>
      <div>
        <label class="label">ชื่อ <span class="text-red-400">*</span></label>
        <input id="f-name" type="text" value="${esc(r?.name || '')}" class="input"
          placeholder="${isInternal ? 'เช่น บัญชีบริษัท, บัญชีคู่, บัญชีกรรมการ' : 'ชื่อลูกค้า หรือ ชื่อผู้จำหน่าย'}">
      </div>
      <div>
        <label class="label">เลขบัญชี / รหัสธุรกรรม</label>
        <input id="f-account_number" type="text" value="${esc(r?.account_number || '')}" class="input" placeholder="เช่น X8049 หรือ xxx-x-xxxxx-x">
        <p class="text-xs text-gray-400 mt-1">ใส่รหัส X#### จาก Statement หรือเลขบัญชีธนาคาร เพื่อให้ระบบจับคู่อัตโนมัติ</p>
      </div>
      <div id="f-extra-fields" ${isInternal ? 'class="hidden"' : ''}>
        <div class="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label class="label">โทรศัพท์</label>
            <input id="f-phone" type="text" value="${esc(r?.phone || '')}" class="input" placeholder="0xx-xxx-xxxx">
          </div>
          <div>
            <label class="label">อีเมล</label>
            <input id="f-email" type="email" value="${esc(r?.email || '')}" class="input" placeholder="example@email.com">
          </div>
        </div>
        <div>
          <label class="label">ที่อยู่</label>
          <textarea id="f-address" rows="2" class="input resize-none" placeholder="ที่อยู่...">${esc(r?.address || '')}</textarea>
        </div>
      </div>
      <div>
        <label class="label">หมายเหตุ</label>
        <textarea id="f-notes" rows="2" class="input resize-none" placeholder="หมายเหตุเพิ่มเติม...">${esc(r?.notes || '')}</textarea>
      </div>
    </div>`

  document.getElementById('modal').classList.remove('hidden')
  document.body.classList.add('overflow-hidden')
}

function onTypeChange(type) {
  const extra = document.getElementById('f-extra-fields')
  if (extra) extra.classList.toggle('hidden', type === 'internal')
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden')
  document.body.classList.remove('overflow-hidden')
  editingId = null
}

async function saveContact() {
  const btn = document.getElementById('btn-save')
  btn.disabled = true
  btn.textContent = 'กำลังบันทึก...'

  try {
    const name = document.getElementById('f-name').value.trim()
    if (!name) { alert('กรุณากรอกชื่อ'); return }

    const type = document.getElementById('f-type').value
    const val = id => document.getElementById(id)?.value.trim() || null
    const payload = {
      type,
      name,
      account_number: val('f-account_number'),
      phone:          val('f-phone'),
      email:          val('f-email'),
      address:        val('f-address'),
      notes:          val('f-notes'),
    }

    const { error } = editingId
      ? await db.from('contacts').update(payload).eq('id', editingId)
      : await db.from('contacts').insert(payload)

    if (error) throw error

    closeModal()

    if (type !== currentTab) {
      document.querySelector(`[data-tab="${type}"]`).click()
    } else {
      await loadContacts(currentTab)
    }

  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message)
  } finally {
    btn.disabled = false
    btn.textContent = 'บันทึก'
  }
}

async function deleteContact(id) {
  if (!confirm('ยืนยันการลบรายชื่อนี้?')) return
  const { error } = await db.from('contacts').delete().eq('id', id)
  if (error) { alert('ลบไม่สำเร็จ: ' + error.message); return }
  await loadContacts(currentTab)
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

document.addEventListener('DOMContentLoaded', initContacts)
