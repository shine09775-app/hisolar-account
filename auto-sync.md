# Auto Sync Notes

เอกสารนี้สรุป logic ของ `Auto Sync` ในระบบ เพื่อใช้เป็นจุดอ้างอิงเวลาปรับปรุงรอบถัดไป

## ไฟล์หลัก

- `app/js/dashboard.js`

logic ของ Auto Sync อยู่ในไฟล์นี้ทั้งหมด

## ฟังก์ชันสำคัญ

### Text normalization

- `normalizeAutoSyncText()`
- `compactAutoSyncText()`
- `stripLeadingMatchNoise()`
- `removeAutoSyncNoise()`
- `stripLeadingBankHint()`
- `extractAutoSyncBankHints()`

ใช้สำหรับทำความสะอาด memo และชื่อในสมุดรายชื่อก่อน match

### Candidate building

- `buildAutoSyncTextCandidates(memo)`
- `buildContactNameCandidates(contact)`
- `parseContactAliasNotes(contact)`

ใช้แตก candidate จาก memo และจากชื่อ/alias ของ contact

### Scoring

- `scoreContactCodeMatch(memo, contact)`
- `scoreInternalBankHint(contact, memo)`
- `tokenOverlapScore(text, name)`
- `fuzzyScore(text, name)`
- `compareAutoSyncText(text, name)`

### Match selection

- `bestExternalContactMatch(t)`
- `bestInternalDirectorMatch(t)`
- `bestContactMatch(t)`

`bestContactMatch()` เป็นจุดรวมสุดท้าย

## เกณฑ์การ match ปัจจุบัน

### External

ใช้กับ `customer` และ `supplier`

- รายรับ → `customer`
- รายจ่าย → `supplier`

### Internal director

ใช้กับ `internal` เฉพาะ contact ที่ resolve role ได้เป็น `director`

รองรับกรณี:

- `โอนไป SCB X0185 นาย วสันต์ ปานแย++`
- `โอนไป BAY X1347 นาย วสันต์ ปานแย++`
- `จาก BAY X1347 WASAN PANY++`
- `จาก BAY X4582 APAPORN THE++`

โดยใช้ข้อมูลร่วมกันดังนี้:

- `X####`
- prefix ธนาคารใน memo เช่น `BAY`, `KTB`, `SCB`, `BBL`, `KK`, `KKP`
- ชื่อไทยแบบเต็ม
- ชื่อไทยแบบถูกตัดท้าย
- alias อังกฤษของกรรมการ
- alias เพิ่มเติมใน `contacts.notes`

## Director profile

profile ของกรรมการเก็บในตัวแปร:

- `DIRECTOR_PROFILES`

ถ้ามีชื่ออังกฤษแบบใหม่ที่ยัง match ไม่ได้ ให้เพิ่ม alias ที่นี่ก่อน

ตัวอย่างที่รองรับแล้ว:

- `wasan panyaim`
- `wasan pany`
- `apaporn thepjan`
- `apaporn the`
- `chaiyawat thepjan`
- `chaiwat`

## Contact data ที่ช่วยให้แม่นขึ้น

ในแท็บ `บัญชีภายใน` ควรเก็บข้อมูลแบบนี้:

- ชื่อบัญชีรวม bank prefix เช่น `SCB วสันต์ ปานแย้ม`
- ถ้ามี `X####` ให้ใส่ใน `account_number`
- ถ้ามีชื่ออังกฤษหรือรูปแบบย่อ ให้ใส่เพิ่มใน `notes`

ตัวอย่าง:

- name: `BAY วสันต์ ปานแย้ม`
- account_number: `X1347`
- notes: `บัญชีกรรมการ, wasan panyaim, wasan pany`

## Threshold

- `AUTO_SYNC_AUTO_THRESHOLD = 0.88`
- `AUTO_SYNC_REVIEW_THRESHOLD = 0.68`

ความหมาย:

- `>= 88%` = auto
- `68% - 87%` = review
- `< 68%` = unmatched

## จุดที่ต้องแก้พร้อมกันถ้าปรับ logic

1. Matcher
   - `bestExternalContactMatch()`
   - `bestInternalDirectorMatch()`
   - `bestContactMatch()`

2. UI badge / modal
   - `renderAutoSyncModal()`
   - `renderSyncSection()`

3. Save behavior
   - `saveSyncSelections()`
   - `saveAutoSyncMatch()`

4. Internal categorization หลังบันทึก
   - `inferInternalCategory()`

## กฎสำคัญ

- ห้ามให้ Auto Sync internal ไปจับ `internal` ที่ไม่ใช่กรรมการ
- ถ้า internal กับ external ได้คะแนนใกล้กัน ให้เลือก internal ก็ต่อเมื่อคะแนนสูงกว่าชัดเจน
- ถ้า memo มี bank hint และ contact มี bank hint ตรงกัน ให้ boost score ได้
- ถ้า match เป็น `internal` แล้ว ตอน save ต้องอัปเดต `transactions.category` ด้วย

## Suggested workflow เวลาจะแก้รอบหน้า

1. เปิด `app/auto-sync.md`
2. เปิด `app/js/dashboard.js`
3. หา function `bestContactMatch()`
4. ไล่กลับไปดู candidate + score helpers
5. ทดสอบกับ memo ตัวอย่างจริงอย่างน้อย 3 แบบ

## ตัวอย่าง memo ที่ควรใช้เป็น regression cases

- `โอนไป SCB X0185 นาย วสันต์ ปานแย++`
- `โอนไป BAY X1347 นาย วสันต์ ปานแย++`
- `จาก BAY X1347 WASAN PANY++`
- `จาก BAY X4582 APAPORN THE++`
- `โอนไป KK X3006 นาย ชัยวัฒน์ เทพจั++`

## Salary rules

- Fixed salary rule for directors:
  - `น.ส. อาภาพร เทพจันทร์` = `15,000` บาท
  - `นาย วสันต์ ปานแย้ม` = `15,000` บาท
- Expected transfer window: day `1-3` of each month
- When Auto Sync matches these rows as internal director accounts, `saveAutoSyncMatch()` should persist `transactions.category = เงินเดือน`
- Main code paths:
  - `scoreDirectorSalaryPattern()`
  - `isLikelySalaryInternalTx()`
  - `inferInternalCategory()`
- Auto Sync should skip only persisted matches from `maintain` records.
  Heuristic rows that are visible from memo/contact parsing must still be saved by Auto Sync.
