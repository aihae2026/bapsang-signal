-- 자료 반영 내역 — 엔컴 엑셀을 누가 언제 얼마나 넣었는지 남깁니다.
--
-- Supabase SQL Editor에 통째로 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- 왜 필요한가: 자료 가져오기는 **승인된 직원 누구나** 할 수 있고, 한 번 넣으면 모든 직원의
-- 화면이 함께 바뀝니다. 그런데 지금은 누가 무엇을 넣었는지 남지 않아, 숫자가 이상해져도
-- 언제 무엇이 들어와서 그런지 되짚을 수가 없습니다. 기록이 있어야 되돌아볼 수 있습니다.

create table if not exists import_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- 누가 넣었는지(로그인 이메일). 지우지 못하게 두어 책임 소재를 남깁니다.
  staff_email text not null default '',
  -- 무엇을 넣었는지
  file_names text not null default '',
  period_from date,
  period_to date,
  record_count integer not null default 0,   -- 엑셀에서 읽은 유효 기록 수
  resident_count integer not null default 0, -- 파일에 등장한 어르신 수
  attendance_rows integer not null default 0,-- 파일에 들어 있던 출결 행 수(시도한 수)
  -- 실제로 "새로" 들어간 수. 이미 있던 (회원번호, 날짜)는 건너뛰므로 아래 둘로 나뉩니다.
  -- 이 숫자가 있어야 "정말 추가가 됐는지"를 눈으로 확인할 수 있습니다.
  new_residents integer not null default 0,
  new_attendance integer not null default 0,
  skipped_attendance integer not null default 0,
  note text not null default ''
);

-- 이미 표를 만든 뒤 이 파일을 다시 실행하는 경우를 위해 칸을 보충합니다.
alter table import_logs add column if not exists new_residents integer not null default 0;
alter table import_logs add column if not exists new_attendance integer not null default 0;
alter table import_logs add column if not exists skipped_attendance integer not null default 0;
create index if not exists import_logs_created_idx on import_logs (created_at desc);

alter table import_logs enable row level security;

-- 승인된 직원은 내역을 읽고, 자기가 넣을 때 기록을 남길 수 있습니다.
-- 수정·삭제 정책은 두지 않습니다 — 기록은 고치지 못해야 기록입니다.
drop policy if exists "import_logs_read_approved" on import_logs;
drop policy if exists "import_logs_insert_approved" on import_logs;

create policy "import_logs_read_approved" on import_logs for select
  using ((select is_approved_user()));
create policy "import_logs_insert_approved" on import_logs for insert
  with check ((select is_approved_user()));

-- ── 확인 ──────────────────────────────────────────────────────
select policyname, cmd from pg_policies where tablename = 'import_logs' order by policyname;
select count(*) as 기록수 from import_logs;
