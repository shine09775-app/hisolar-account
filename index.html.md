# Dashboard Spec For `index.html`

เอกสารนี้สรุปโครงสร้างหน้า `index.html` และ logic ที่ต้องรักษาไว้เมื่อมีการปรับปรุงรอบถัดไป

## วัตถุประสงค์

หน้า `index.html` คือหน้า Dashboard หลักของระบบบัญชี Hi Solar สำหรับดูภาพรวมธุรกรรมทั้งหมดและจัดการรายการธุรกรรมรายแถว

## ส่วนประกอบหลักของหน้า

1. Navbar
   - เมนูหลัก: `Dashboard`, `โอนระหว่างบัญชี`, `Upload`, `Upload Log`, `ข้อมูลรายการ`, `สมุดรายชื่อ`

2. Header
   - ชื่อหน้า: `สรุปบัญชี Hi Solar`
   - ช่วงวันที่ข้อมูล: element `#data-range`
   - ปุ่มไปหน้า upload

3. Tab Navigation
   - `overview`
   - ลิงก์ไปหน้า `internal-transfers.html`

4. Summary Cards
   - `#card-income`
   - `#card-expense`
   - `#card-balance`
   - `#card-count`

5. Filter Form
   - `#filter-account`
   - `#filter-contact-type`
   - `#filter-contact-name`
   - `date-from`
   - `date-to`
   - `search`

6. Charts
   - `#chart-monthly`
   - `#chart-expense-group`
   - `#chart-income-customer`
   - VAT summary panel

7. Transaction Table
   - body: `#tx-tbody`
   - count: `#tx-count`
   - actions:
     - `#auto-sync-btn`
     - `#delete-joint-account-btn`

## Data Sources

- `transactions`
- `contacts`
- `income_records`
- `expense_records`
- `transaction_vat`
- `upload_logs`

## Naming And Group Rules

### บัญชีภายใน

ใช้ 3 กลุ่มเท่านั้น

- `บัญชีบริษัท` = บัญชีหลักของบริษัท
- `บัญชีคู่` = บัญชีร่วมของ `น.ส. อาภาพร เทพจันทร์` และ `นาย วสันต์ ปานแย้ม`
- `บัญชีกรรมการ` = ทุกบัญชีส่วนตัวของกรรมการ 3 คนนี้เท่านั้น
  - `น.ส. อาภาพร เทพจันทร์`
  - `นาย วสันต์ ปานแย้ม`
  - `นายชัยวัฒน์ เทพจันทร์`

ห้ามตีความ `internal contact` อื่นเป็น `บัญชีกรรมการ` โดยอัตโนมัติ

### ประเภทธุรกรรมภายใน

- `โอนระหว่างบัญชี` = ธุรกรรมระหว่าง `บัญชีบริษัท` กับ `บัญชีคู่`
- `โอนออกให้กรรมการ` = `บัญชีบริษัท/บัญชีคู่ → บัญชีกรรมการ`
- `โอนเข้าจากกรรมการ` = `บัญชีกรรมการ → บัญชีบริษัท/บัญชีคู่`
- `เงินเดือน` = จ่ายให้กรรมการในลักษณะเงินเดือน
- `เคลียร์การเบิกจ่าย` = รายการเคลียร์กับกรรมการ
- `ปันผลกรรมการ` = จ่ายปันผลจาก `บัญชีคู่ → บัญชีกรรมการ`
- `อื่นๆ` = รายการภายในที่ไม่เข้าเงื่อนไขข้างต้น

## Important JS Dependencies

หน้า `index.html` พึ่งพาไฟล์เหล่านี้โดยตรง

- `js/config.js`
- `js/mappings.js`
- `js/dashboard.js`

logic สำคัญอยู่ใน `dashboard.js`

- โหลดธุรกรรมและ contacts
- render dashboard
- auto sync
- manual link
- VAT
- internal transaction detection

หน้า `index.html` ไม่มี logic แท็บ `โอนระหว่างบัญชี` แบบ inline แล้ว
source เดียวของหน้ารายการภายในคือ `internal-transfers.html` + `js/internal-transfers.js`

## Change Rules For Future Work

1. ถ้าปรับชื่อเมนูหรือข้อความในหน้า ให้ตรวจทั้ง `index.html` และหน้าอื่นที่ใช้ navbar เดียวกัน
2. ถ้าปรับ logic รายการภายใน ให้แก้ที่ `dashboard.js` ก่อน ไม่ใช่แก้เฉพาะ HTML
3. ถ้ามีการเพิ่มประเภทใหม่ในรายการภายใน ต้องอัปเดตพร้อมกัน 4 จุด
   - constants ของประเภท
   - logic detection
   - badge/render
   - chart summary
4. ถ้าปรับข้อความไทย ให้ระวัง encoding ของไฟล์ โดยเฉพาะ `mappings.js` และไฟล์ HTML เก่า
5. ถ้าปรับ account display name ให้รักษา alias เดิมไว้ด้วย เพื่อรองรับข้อมูลเก่าในฐาน

## Regression Checklist

ก่อน deploy รอบถัดไป ควรตรวจอย่างน้อย:

- transaction table ยังแสดง `บัญชีบริษัท` และ `บัญชีคู่` ถูกต้อง
- หน้า `โอนระหว่างบัญชี` ไม่ดึงบุคคลที่ไม่ใช่กรรมการเข้ามา
- `Auto Sync` ไม่ทำให้ธุรกรรมคนละแถวเปลี่ยนตามกัน
- legend ของกราฟภาษาไทยไม่เพี้ยน
- ปุ่ม manual link เลือก `🏦 บัญชีภายใน` ได้
- ปุ่มรวมชื่อเก่าเป็น `บัญชีคู่` ยังทำงานได้
