-- ════════════════════════════════════════════════════════════════════
-- migration_026 — 확인 기록에 「어르신 반응」 칸을 답니다
-- ════════════════════════════════════════════════════════════════════
--
-- 왜 필요한가:
--
--   이 도구가 실제로 무엇을 바꿨는지 재는 칸이 지금 하나도 없습니다. 「지원 필요 비율」은
--   담당자가 판단한 값이고, 어르신 쪽에서 이 전화가 어떻게 받아들여졌는지는 아무 데도
--   안 남습니다. 그런데 현장에서 가장 자주 나오는 이야기가 그것입니다 —
--   "걱정해 줘서 고맙다고 하시더라", "왜 자꾸 전화하냐고 하시더라".
--
--   한 해 치를 모으면 「우리가 연락드린 것이 어르신께 어떻게 닿았는가」를 숫자로
--   말할 수 있습니다. 그건 출석률로는 절대 안 나오는 이야기입니다.
--
-- 값은 셋입니다. 안 고르면 null 이고, null 이 기본입니다 —
--   'positive'  고마워하심 · 반가워하심 · 안부를 되물으심
--   'negative'  불편해하심 · 귀찮아하심 · 전화를 꺼리심
--   null        아직 안 골랐거나 판단하기 어려움
--
-- 실행: Supabase 대시보드 → SQL Editor → 붙여넣고 Run

alter table public.followups
  add column if not exists reaction text
  check (reaction in ('positive', 'negative'));

comment on column public.followups.reaction is
  '연락드렸을 때 어르신 반응. positive=고마워하심, negative=불편해하심, null=안 고름';

-- 연간 집계에서 쓰는 순서대로. 기간(checked_at)으로 먼저 자르고 반응으로 묶습니다.
create index if not exists followups_reaction_idx
  on public.followups (checked_at, reaction)
  where reaction is not null;


-- ── 확인 ───────────────────────────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'followups'
      and column_name = 'reaction')                          as "reaction 칸(1이어야 함)",
  (select count(*) from public.followups)                    as "기존 확인 기록 수",
  (select count(*) from public.followups where reaction is not null)
                                                             as "반응이 적힌 기록(처음엔 0)";
