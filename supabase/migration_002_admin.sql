-- ⚠️ 004 이후에는 절대 재실행하지 마십시오.
--    아래 staff_all_anon / holidays 정책은 `using (true)` 입니다. RLS 정책은 OR 로 합쳐지기
--    때문에, 004~014 로 잠근 DB 에 이 파일을 다시 돌리면 staff·holidays 가 익명 읽기·쓰기로
--    통째로 되돌아갑니다. 이 파일은 최초 1회만 유효합니다.

-- 어드민 페이지 기능 추가 마이그레이션 (기존 DB에 실행)
-- Supabase SQL Editor에서 실행하세요.

alter table residents
  add column if not exists status text not null default 'active' check (status in ('active', 'discharged'));

create table if not exists staff (
  name text primary key
);

create table if not exists holidays (
  date date primary key,
  label text not null
);

alter table staff enable row level security;
alter table holidays enable row level security;

create policy "staff_all_anon" on staff for all using (true) with check (true);
create policy "holidays_all_anon" on holidays for all using (true) with check (true);
