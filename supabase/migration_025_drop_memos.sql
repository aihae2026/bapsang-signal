-- ════════════════════════════════════════════════════════════════════
-- migration_025 — 관찰 메모 표를 없앱니다
-- ════════════════════════════════════════════════════════════════════
--
-- 메모 기능은 현장에서 쓰이지 않았습니다. 화면에서는 `018ba4e` 에서 내렸고, 판정
-- 근거를 만드는 코드까지 `c3d7ac9` 에서 걷어냈습니다. 이제 앱은 이 표를 **읽지도
-- 쓰지도 않습니다.**
--
-- 표를 남겨두면 두 가지가 걸립니다 —
--   ① 어르신의 건강·정서 기록이 아무도 안 보는 곳에 계속 남습니다. 보관은 그 자체로
--      위험이고, 지우는 것이 개인정보 보호에 맞습니다(수집 목적이 사라졌습니다).
--   ② 다음 사람이 이 표를 보고 "살아 있는 기능"으로 오해합니다.
--
-- ⚠️ 되돌릴 수 없습니다. 아래 0번을 먼저 돌려 무엇이 지워지는지 보고 진행하세요.
--
-- 실행: Supabase 대시보드 → SQL Editor → 붙여넣고 Run


-- ── 0. 먼저 이것만 돌려 보세요 (지우지 않습니다) ───────────────────
--
-- 몇 건이 있고, 언제 것들인지 확인합니다. 0 건이면 마음 편히 진행하시면 되고,
-- 기록이 남아 있다면 아래 1번에서 파일로 내려받은 뒤 지우시길 권합니다.
--
-- select count(*) as 메모건수,
--        min(date) as 가장오래된것,
--        max(date) as 가장최근것,
--        count(distinct resident_id) as 어르신수
--   from public.memos;


-- ── 1. (선택) 지우기 전에 내려받기 ────────────────────────────────
--
-- 사회복지사업법상 상담·기록 보존 의무가 걸리는 내용이 섞여 있을 수 있습니다.
-- 관장님·과장님께 확인이 필요하시면, 아래를 SQL Editor 에서 돌린 뒤 결과 표
-- 오른쪽 위 「Download CSV」 로 받아 **기관 내부 저장소**에 보관하세요.
-- (어르신 실명·건강 정보가 들어 있으니 개인 PC 나 클라우드에 두지 마세요.)
--
-- select m.date as 날짜, r.name as 어르신, m.author as 작성자,
--        m.text as 내용, m.tags as 분류, m.tone as 성격
--   from public.memos m
--   join public.residents r on r.id = m.resident_id
--  order by m.date desc;


-- ── 2. 실제로 지웁니다 ────────────────────────────────────────────
--
-- cascade 는 이 표에 딸린 것들을 함께 걷어냅니다 —
--   · 색인 memos_resident_idx
--   · RLS 정책 memos_read_approved 외 셋 (migration_012)
--   · 트리거 flag_ai_on_memo_ins (migration_017)
--
-- 트리거가 부르는 **함수 flag_ai_needs_update() 는 남깁니다.** 확인 기록(followups)
-- 트리거가 같은 함수를 쓰고 있어서, 함께 지우면 「확인 기록을 남겨도 AI 설명이
-- 낡은 채로 남는」 조용한 고장이 납니다.
drop table if exists public.memos cascade;

-- residents 표의 「마지막 메모」 칸도 같이 내립니다. 앱이 더 이상 쓰지 않습니다.
alter table public.residents drop column if exists latest_memo;


-- ── 3. 확인 ───────────────────────────────────────────────────────
select
  (select count(*) from pg_tables
    where schemaname = 'public' and tablename = 'memos')            as "memos 표(0이어야 함)",
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'residents'
      and column_name = 'latest_memo')                              as "latest_memo 칸(0이어야 함)",
  (select count(*) from pg_proc
    where proname = 'flag_ai_needs_update')                         as "AI 갱신 함수(1이어야 함)",
  (select count(*) from pg_trigger
    where tgname = 'flag_ai_on_followup_ins')                       as "확인기록 트리거(1이어야 함)";
