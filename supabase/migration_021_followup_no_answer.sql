-- 연락 결과에 「부재중」을 추가합니다.
--
-- Supabase SQL Editor에 통째로 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- 왜 필요한가: 지금 고를 수 있는 결과는 '개입 필요 / 개입 불필요' 둘뿐입니다. 그런데 현장에서
-- 가장 많은 상황은 **전화를 안 받으시는 것**입니다. 이걸 '개입 불필요'로 찍으면 그 어르신은
-- 안심 처리되어 목록에서 사라집니다 — 연락이 닿지 않는 분이야말로 가장 먼저 다시 봐야 하는데,
-- 지금 구조는 그분을 가장 먼저 지웁니다. 그래서 결과 하나를 더 둡니다.
--
-- 부재중은 짧은 기한(기본 3일)으로 잠시 내려두었다가 자동으로 다시 올라옵니다.

alter table followups drop constraint if exists followups_outcome_check;

alter table followups
  add constraint followups_outcome_check
  check (outcome in ('needed', 'not_needed', 'no_answer'));

-- ── 확인 ──────────────────────────────────────────────────────
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'followups'::regclass and conname = 'followups_outcome_check';
