-- ════════════════════════════════════════════════════════════════════
-- ⛔ **이미 돌아가는 데이터베이스에는 다시 실행하지 마십시오.**
-- ════════════════════════════════════════════════════════════════════
--
-- 이 파일은 **처음 한 번** 표를 만드는 파일입니다. 그때는 대회 심사용으로 조회를
-- 열어 두어야 했기 때문에, 아래에 이런 것들이 들어 있습니다 —
--
--   · 어르신 사진 보관함을 **공개(public = true)** 로 만듭니다
--   · residents·attendance 를 **`using (true)`** — 즉 누구나 읽게 엽니다
--   · `resident_photos_read_anon` — 로그인 없이 사진을 읽는 정책
--
-- 그 뒤 migration_012 가 모든 표를 「승인받은 직원만」으로 좁혔고,
-- migration_014 가 사진 보관함을 비공개로 내렸습니다.
--
-- **Postgres 는 같은 표의 정책을 OR 로 합칩니다.** 이 파일을 다시 돌리면
-- 열어 두는 정책이 되살아나 그 잠금이 통째로 풀립니다. 사진 보관함은 더 위험합니다 —
-- `public = true` 가 되면 `/object/public/` 경로가 **정책 자체를 우회**해,
-- 어르신 얼굴 사진이 주소만 알면 누구나 보이는 상태가 됩니다.
--
-- 새 프로젝트를 처음 만들 때만 쓰십시오. 지금 상태를 확인하려면
-- supabase/security_check_live_state.sql 을 실행하십시오(읽기만 합니다).
-- ════════════════════════════════════════════════════════════════════

-- ⚠️ 이 파일만 실행하고 멈추면 안 됩니다.
--    여기서는 residents·attendance 가 아직 `using (true)` — 로그인 없이도 읽힙니다.
--    잠그는 것은 migration_012 와 migration_014 입니다. 반드시 migration_002 부터
--    migration_028 까지 번호 순서대로 이어서 실행하십시오.
--
-- ⚠️ 이 순서는 **최초 설치 한 번**을 위한 것입니다. 이미 돌아가는 DB 에 옛 번호를 다시
--    실행하면 뒤 마이그레이션을 되돌립니다 — 특히 **003**(사진 버킷 개방)·**004**(명단·
--    출결·직원·휴관일 개방)·005(확인 기록 개방)·022(갈래 제약)가 그렇습니다.
--    각 파일 머리말의 경고를 읽어보십시오. 그중 004 가 가장 넓게 엽니다.

-- 밥상위의 신호: Supabase 스키마
-- Supabase 대시보드 SQL Editor에 붙여넣고 실행하세요 (Database → SQL Editor → New query).

create table if not exists residents (
  id text primary key,
  name text not null,
  age_group text not null,
  caseworker text not null,
  phone text not null,
  registered_at date not null,
  notes text not null default '',
  status text not null default 'active' check (status in ('active', 'discharged')),
  photo_url text,
  created_at timestamptz not null default now()
);

create table if not exists attendance (
  id bigint generated always as identity primary key,
  resident_id text not null references residents (id) on delete cascade,
  date date not null,
  present boolean not null,
  unique (resident_id, date)
);
create index if not exists attendance_resident_date_idx on attendance (resident_id, date);

-- 담당 직원 목록 (어드민 페이지에서 관리)
create table if not exists staff (
  name text primary key
);

-- 공휴일 목록 (어드민 페이지에서 관리) — 개인별 위험도 계산에서 제외되는 날짜입니다.
create table if not exists holidays (
  date date primary key,
  label text not null
);

-- 조회는 누구나(대시보드·리포트는 로그인 없이 볼 수 있어야 함), 추가/수정/삭제는 로그인한
-- 직원(Supabase Auth)만 가능하도록 분리합니다. 관리자 설정 페이지에서 로그인을 요구합니다.
alter table residents enable row level security;
alter table attendance enable row level security;
alter table staff enable row level security;
alter table holidays enable row level security;

create policy "residents_read_anon" on residents for select using (true);
create policy "residents_insert_auth" on residents for insert with check (auth.role() = 'authenticated');
create policy "residents_update_auth" on residents for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "residents_delete_auth" on residents for delete using (auth.role() = 'authenticated');

create policy "attendance_read_anon" on attendance for select using (true);
create policy "attendance_insert_auth" on attendance for insert with check (auth.role() = 'authenticated');
create policy "attendance_update_auth" on attendance for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "attendance_delete_auth" on attendance for delete using (auth.role() = 'authenticated');

create policy "staff_read_anon" on staff for select using (true);
create policy "staff_insert_auth" on staff for insert with check (auth.role() = 'authenticated');
create policy "staff_delete_auth" on staff for delete using (auth.role() = 'authenticated');

create policy "holidays_read_anon" on holidays for select using (true);
create policy "holidays_insert_auth" on holidays for insert with check (auth.role() = 'authenticated');
create policy "holidays_delete_auth" on holidays for delete using (auth.role() = 'authenticated');

-- 어르신 실물 사진 저장용 Storage 버킷 (없으면 일러스트 아바타로 대체됩니다)
-- 조회(사진 표시)는 공개, 업로드/수정/삭제는 로그인한 직원만 가능합니다.
insert into storage.buckets (id, name, public)
values ('resident-photos', 'resident-photos', true)
on conflict (id) do nothing;

create policy "resident_photos_read_anon" on storage.objects for select
  using (bucket_id = 'resident-photos');
create policy "resident_photos_insert_auth" on storage.objects for insert
  with check (bucket_id = 'resident-photos' and auth.role() = 'authenticated');
create policy "resident_photos_update_auth" on storage.objects for update
  using (bucket_id = 'resident-photos' and auth.role() = 'authenticated')
  with check (bucket_id = 'resident-photos' and auth.role() = 'authenticated');
create policy "resident_photos_delete_auth" on storage.objects for delete
  using (bucket_id = 'resident-photos' and auth.role() = 'authenticated');
