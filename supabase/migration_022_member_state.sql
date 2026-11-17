-- 회원 상태 관리 (구현요청서 9장) + 확인 결과 분류 (8-1)
--
-- Supabase SQL Editor에 통째로 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- 왜 필요한가: 지금은 "확인했다/안 했다"만 남습니다. 그런데 현장에서 나오는 답은
-- 열 가지쯤 됩니다 — 돌아가셨다, 요양원에 가셨다, 이사 가셨다, 경로당에 다니신다,
-- 일자리 나가신다, 더워서 쉬신다, 전화를 안 받으신다…
--
-- 이걸 구분하지 않으면 두 가지가 무너집니다.
--   1) 돌아가신 분이 계속 명단에 뜹니다. 담당자가 목록을 안 보게 됩니다.
--   2) "추석 이후 나오신다"고 하셨는데 안 나오셔도 아무도 모릅니다. 그게 진짜 신호인데요.

-- ── 1. 회원 상태 ──────────────────────────────────────────────
-- 감시중: 매일 판정 / 보류: 판정 중단, 출석 1건이면 자동 해제 / 종료: 자동 해제 없음
alter table residents add column if not exists watch_status text not null default '감시중';
alter table residents add column if not exists resume_expected date;
alter table residents add column if not exists downgrade_count integer not null default 0;

alter table residents drop constraint if exists residents_watch_status_check;
alter table residents
  add constraint residents_watch_status_check
  check (watch_status in ('감시중', '보류', '종료'));

-- ── 2. 확인 결과 분류 ─────────────────────────────────────────
-- 담당자가 자유롭게 쓴 메모를 분류한 결과입니다. 원문(note)은 그대로 둡니다 —
-- 분류만 남기면 나중에 검증할 수가 없습니다.
alter table followups add column if not exists result_kind text;
alter table followups add column if not exists resume_expected date;

-- ⚠️ 이 블록은 migration_028 이 대신합니다. 다시 실행하지 마십시오.
--
--    028 이 같은 제약을 갈래 하나를 더해 다시 만들었습니다. 이 파일을 나중에 또 돌리면
--    **028 을 되돌립니다.** 그리고 그 갈래로 저장된 행이 하나라도 있으면 add constraint 가
--    검증에 걸려 이 스크립트 전체가 실패하고, 아래 residents 변경까지 함께 롤백됩니다.
--    최초 1회 설치에서는 028 이 뒤에 오므로 결과가 같습니다 — 그래서 지워도 안전합니다.
--
-- alter table followups drop constraint if exists followups_result_kind_check;
-- alter table followups
--   add constraint followups_result_kind_check
--   check (result_kind is null or result_kind in (
--     '위기', '사망', '요양원입소', '이사전출', '급식자격상실',
--     '타기관이용', '일자리프로그램참여', '일시적사정', '이용감소', '확인불가'
--   ));

-- ── 3. 확인 ──────────────────────────────────────────────────
select column_name, data_type
from information_schema.columns
where table_name = 'residents'
  and column_name in ('watch_status', 'resume_expected', 'downgrade_count')
order by column_name;

select column_name, data_type
from information_schema.columns
where table_name = 'followups' and column_name in ('result_kind', 'resume_expected')
order by column_name;
