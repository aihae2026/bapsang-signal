-- ════════════════════════════════════════════════════════════════════
-- migration_003b — 새로 설치할 때만: 빈 memos 표를 미리 만듭니다
-- ════════════════════════════════════════════════════════════════════
--
-- ⛔ **이미 돌아가는 데이터베이스에는 실행하지 마십시오.** migration_025 가 지운 표를
--    빈 채로 되살립니다.
--
-- 왜 필요한가 — 예전 「관찰 메모」 표(memos)는 처음에 대시보드에서 직접 만들었고, 만드는
-- SQL 이 이 저장소에 없습니다. 그런데 migration_004·006·012·017 이 그 표에 정책·트리거를
-- 겁니다. 빈 Supabase 프로젝트에 schema.sql 부터 차례로 실행하면 004 에서
-- 「relation "memos" does not exist」로 멈춥니다.
--
-- 그래서 003 과 004 사이에 빈 표를 하나 만들어 둡니다. 이 표는 앱이 읽지도 쓰지도 않으며,
-- 마지막에 migration_025 가 지웁니다. 순서: schema.sql → 002 → 003 → **003b** → 004 → … → 028
--
-- 실행: Supabase 대시보드 → SQL Editor → 붙여넣고 Run

create table if not exists memos (
  id bigint generated always as identity primary key,
  resident_id text not null references residents (id) on delete cascade,
  date date not null default current_date,
  content text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists memos_resident_idx on memos (resident_id);
alter table memos enable row level security;

drop policy if exists "residents_read_anon" on residents;
drop policy if exists "residents_insert_auth" on residents;
drop policy if exists "residents_update_auth" on residents;
drop policy if exists "residents_delete_auth" on residents;
drop policy if exists "attendance_read_anon" on attendance;
drop policy if exists "attendance_insert_auth" on attendance;
drop policy if exists "attendance_update_auth" on attendance;
drop policy if exists "attendance_delete_auth" on attendance;
drop policy if exists "staff_read_anon" on staff;
drop policy if exists "staff_insert_auth" on staff;
drop policy if exists "staff_delete_auth" on staff;
drop policy if exists "holidays_read_anon" on holidays;
drop policy if exists "holidays_insert_auth" on holidays;
drop policy if exists "holidays_delete_auth" on holidays;
drop policy if exists "resident_photos_read_anon" on storage.objects;
drop policy if exists "resident_photos_insert_auth" on storage.objects;
drop policy if exists "resident_photos_update_auth" on storage.objects;
drop policy if exists "resident_photos_delete_auth" on storage.objects;
