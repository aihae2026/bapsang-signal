-- 앱 설정 저장소. 지금은 "참고 외부변수를 쓸지 말지" 스위치를 담습니다.
-- Supabase SQL Editor에서 실행하세요. 여러 번 실행해도 안전합니다.
--
-- ⚠️ migration_010_self_signup_approval.sql 을 먼저 실행해야 합니다.
--    이 파일이 그쪽에서 만든 is_approved_user() 함수를 씁니다.
--    아래 첫 블록이 순서를 확인해서, 안 되어 있으면 알아보기 쉬운 오류를 냅니다.
--
-- ── 왜 브라우저(localStorage)가 아니라 데이터베이스인가 ────
-- 이 스위치는 위험도 판단을 어떻게 읽을지에 대한 기관의 결정입니다. 브라우저에 저장하면
-- 담당자가 "장날 변수는 근거가 없으니 끄자"고 결정해도 다른 직원 화면에는 그대로 남습니다.
-- 같은 어르신을 두고 두 사람이 다른 근거를 보게 되므로, 한곳에 두고 모두가 같은 것을 봅니다.

do $chk$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_approved_user' and n.nspname = 'public'
  ) then
    raise exception
      'migration_010_self_signup_approval.sql 을 먼저 실행해주세요 (is_approved_user 함수가 없습니다).';
  end if;
end $chk$;

create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  -- 누가 마지막으로 바꿨는지 남깁니다. 어느 날 갑자기 판단 기준이 달라 보일 때
  -- "누가 언제 껐나"를 되짚을 수 있어야 합니다.
  updated_by text not null default ''
);

alter table app_settings enable row level security;

-- 승인된 직원만 읽고 씁니다. 개인정보는 없지만, 판단 기준을 아무나 바꿀 수는 없어야 합니다.
drop policy if exists "app_settings_read_approved" on app_settings;
create policy "app_settings_read_approved" on app_settings for select
  using (is_approved_user());

drop policy if exists "app_settings_write_approved" on app_settings;
create policy "app_settings_write_approved" on app_settings for insert
  with check (is_approved_user());

drop policy if exists "app_settings_update_approved" on app_settings;
create policy "app_settings_update_approved" on app_settings for update
  using (is_approved_user()) with check (is_approved_user());

-- 기본값은 근거의 세기로 정합니다.
--
-- 켜둔 변수가 붙은 날은 개인 위험도 계산에서 빠집니다. 그러면 그날 안 나오신 것이 기록에
-- 남지 않습니다. 장날만 해도 매달 6일 — 운영일의 30%입니다. 검증도 안 된 가설로 그만큼을
-- 지우면, 하필 그날부터 안 나오기 시작한 어르신이 통째로 가려집니다.
--
-- 그래서 근거가 확실한 것만 켜고 시작합니다. 나머지는 화면의 출석률 차이를 보고 담당자가
-- 직접 켭니다 — 우리 자료로 효과가 확인된 뒤에 켜는 것이 순서입니다.
insert into app_settings (key, value, updated_by)
values (
  'reference_factors',
  '{"special": true, "badWeather": true, "market": false, "holidayAdjacent": false, "pension": false}'::jsonb,
  'migration_011'
)
on conflict (key) do nothing;

-- 확인
select key, value, updated_at, updated_by from app_settings order by key;
