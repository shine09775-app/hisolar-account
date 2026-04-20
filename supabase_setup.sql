-- ============================================================
-- Hi Solar — Maintain Tables & Storage Setup
-- วิธีใช้: เปิด Supabase Dashboard → SQL Editor → วางโค้ดนี้ → Run
-- ============================================================

-- 1. ตาราง income_records (บัญชีรายได้)
create table if not exists income_records (
  id               uuid default gen_random_uuid() primary key,
  customer_name    text not null,
  account_number   text,
  job_name         text,
  job_details      text,
  amount           numeric(12,2),
  transaction_date date,
  file_url         text,
  file_name        text,
  created_at       timestamptz default now()
);

-- 2. ตาราง expense_records (บัญชีรายจ่าย)
create table if not exists expense_records (
  id               uuid default gen_random_uuid() primary key,
  supplier_name    text not null,
  account_number   text,
  details          text,
  amount           numeric(12,2),
  transaction_date date,
  file_url         text,
  file_name        text,
  created_at       timestamptz default now()
);

-- 3. เปิด Row Level Security + อนุญาต anon ทำได้ทุก operation
alter table income_records  enable row level security;
alter table expense_records enable row level security;

create policy "allow_all_income"   on income_records  for all using (true) with check (true);
create policy "allow_all_expense"  on expense_records for all using (true) with check (true);

-- 3b. ตาราง contacts (สมุดรายชื่อ — ลูกค้าและผู้จำหน่าย)
create table if not exists contacts (
  id             uuid default gen_random_uuid() primary key,
  type           text not null check (type in ('customer', 'supplier')),
  name           text not null,
  account_number text,
  phone          text,
  email          text,
  address        text,
  notes          text,
  created_at     timestamptz default now()
);

alter table contacts enable row level security;
create policy "allow_all_contacts" on contacts for all using (true) with check (true);

-- หากรัน SQL นี้หลังจากสร้าง contacts table แล้ว ให้รัน ALTER นี้เพื่อเพิ่ม 'internal':
-- alter table contacts drop constraint if exists contacts_type_check;
-- alter table contacts add constraint contacts_type_check
--   check (type in ('customer', 'supplier', 'internal'));

-- 6. ตาราง transaction_vat — เก็บ flag ว่า transaction นั้น มี VAT หรือไม่
create table if not exists transaction_vat (
  transaction_id text primary key,
  created_at     timestamptz default now()
);
alter table transaction_vat enable row level security;
create policy "allow_all_vat" on transaction_vat for all using (true) with check (true);

-- 4. สร้าง Storage Bucket "attachments" (public = เปิดดูได้โดยไม่ต้อง login)
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;

-- 5. Storage Policies
create policy "public_read_attachments"
  on storage.objects for select
  using (bucket_id = 'attachments');

create policy "anon_upload_attachments"
  on storage.objects for insert
  with check (bucket_id = 'attachments');

create policy "anon_update_attachments"
  on storage.objects for update
  using (bucket_id = 'attachments');

create policy "anon_delete_attachments"
  on storage.objects for delete
  using (bucket_id = 'attachments');
