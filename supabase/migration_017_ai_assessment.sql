-- AI 판단(설명 문장) 저장 · 사용량 기록 · 월 비용 상한.
--
-- 설계 요약(팀 안내와 동일):
--  · 위기 "감지"는 프로그램이 공짜로 합니다. AI는 "왜 위험한지 한 문장"만 얹습니다.
--  · 바뀐 사람만(플래그) 분석하고, 1인 1호출로 정확하게 부릅니다.
--  · 이번 달 누적이 상한(기본 $7 ≈ ₩10,000)을 넘으면 그 달엔 더 호출하지 않습니다.
--  · API 키는 Edge Function(서버)에만 둡니다. 화면엔 절대 두지 않습니다.

-- ── 1. residents: AI 판단 결과 + "다시 분석 필요" 플래그 ──────────
alter table residents add column if not exists ai_summary text;
alter table residents add column if not exists ai_summary_at timestamptz;
alter table residents add column if not exists ai_summary_model text;
-- true 인 사람만 AI가 다시 봅니다(첫날 전원 true → 분석 후 false → 바뀌면 다시 true).
alter table residents add column if not exists ai_needs_update boolean not null default true;

-- ── 2. 사용량 기록 (비용 상한의 근거) ─────────────────────────
create table if not exists ai_usage (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  resident_id text references residents (id) on delete set null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  -- 이 한 건에 든 비용(USD). Edge Function 이 모델 단가로 계산해 적습니다.
  cost_usd numeric(10, 6) not null default 0
);
create index if not exists ai_usage_created_idx on ai_usage (created_at);

alter table ai_usage enable row level security;
-- 승인된 직원은 "얼마 썼나"를 볼 수 있습니다. 넣는 것은 Edge Function(service_role)만 —
-- service_role 은 RLS 를 우회하므로 insert 정책을 따로 두지 않습니다(=아무도 손으로 못 넣음).
drop policy if exists "ai_usage_read_approved" on ai_usage;
create policy "ai_usage_read_approved" on ai_usage for select
  using ((select is_approved_user()));

-- ── 3. 월 비용 상한 설정 (화면에서 바꿀 수 있게 app_settings 에) ──
-- ₩10,000 ≈ $7. 환율이 움직이니 USD 로 두고, 화면에 ₩도 함께 보여줍니다.
insert into app_settings (key, value, updated_by)
values ('ai_monthly_cap_usd', '{"cap": 7}'::jsonb, 'migration_017')
on conflict (key) do nothing;

-- ── 4. 이번 달 누적 비용 조회 (화면·Edge Function 공용) ──────────
-- 한국 시간(Asia/Seoul) 기준 그 달 1일부터 합산합니다.
create or replace function ai_month_spend() returns numeric
language sql
security definer
set search_path = public
stable
as $fn$
  select coalesce(sum(cost_usd), 0)
  from ai_usage
  where created_at >= date_trunc('month', (now() at time zone 'Asia/Seoul'))
                      at time zone 'Asia/Seoul';
$fn$;

grant execute on function ai_month_spend() to authenticated, anon;

-- ── 5. 확인 기록이 달리면 그 어르신을 "다시 분석 필요"로 표시 ────
--
-- 담당자가 연락해서 뭔가 알아낸 순간이, AI 설명을 다시 써야 하는 순간입니다.
-- "전화 안 받으심"이 들어왔는데 어제 쓴 설명이 그대로 붙어 있으면 안 됩니다.
--
-- (메모 표에도 같은 트리거를 겁니다. 지금은 화면에서 메모를 내렸지만 표와 함수는
--  그대로 두었고, 나중에 직원이 쓰는 관찰 메모로 다시 켤 때 이 트리거가 필요합니다.)
create or replace function flag_ai_needs_update() returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update residents set ai_needs_update = true where id = new.resident_id;
  return new;
end;
$fn$;

drop trigger if exists flag_ai_on_memo_ins on memos;
create trigger flag_ai_on_memo_ins after insert on memos
  for each row execute function flag_ai_needs_update();

drop trigger if exists flag_ai_on_followup_ins on followups;
create trigger flag_ai_on_followup_ins after insert on followups
  for each row execute function flag_ai_needs_update();

-- ── 확인 ────────────────────────────────────────────────────
select 'ai_needs_update=true 인 어르신' as 항목, count(*) as 수 from residents where ai_needs_update
union all
select '이번 달 AI 비용(USD)', ai_month_spend();
