-- 날씨 보관 — 한 번 받은 날은 다시 받지 않습니다.
--
-- Supabase SQL Editor에 통째로 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- 왜 필요한가: 지금은 화면을 열 때마다 **620일치 날씨를 통째로** 다시 받아옵니다.
-- 직원이 여러 명이고 하루에도 여러 번 들어오면 외부 API 호출 한도에 걸리고, 걸리면
-- 날씨가 통째로 비어 화면의 근거 문구가 사라집니다(실제로 그런 상태였습니다).
--
-- 지난 날씨는 바뀌지 않으므로 한 번만 받아 두면 됩니다. 새로 생긴 날짜만 받아와
-- 여기에 덧붙입니다. 그래서 자료가 늘어나도 호출은 늘지 않습니다.

create table if not exists weather (
  date date primary key,
  precipitation_mm numeric(6, 2) not null default 0,
  snowfall_cm numeric(6, 2) not null default 0,
  temp_max numeric(5, 1) not null default 0,
  temp_min numeric(5, 1) not null default 0,
  apparent_max numeric(5, 1) not null default 0,
  fetched_at timestamptz not null default now()
);

alter table weather enable row level security;

-- 날씨는 개인정보가 아니라 공개된 기상 자료입니다. 다만 이 앱은 승인된 직원만 쓰므로
-- 읽기·쓰기 모두 승인된 계정으로 제한합니다(다른 표와 같은 기준을 지킵니다).
drop policy if exists "weather_read_approved" on weather;
drop policy if exists "weather_write_approved" on weather;
drop policy if exists "weather_update_approved" on weather;

create policy "weather_read_approved" on weather for select
  using ((select is_approved_user()));
create policy "weather_write_approved" on weather for insert
  with check ((select is_approved_user()));
create policy "weather_update_approved" on weather for update
  using ((select is_approved_user()))
  with check ((select is_approved_user()));

-- ── 확인 ──────────────────────────────────────────────────────
select count(*) as 보관된_날짜수, min(date) as 처음, max(date) as 마지막 from weather;
