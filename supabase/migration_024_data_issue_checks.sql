-- 자료 점검 — "이 건은 봤습니다" 표시.
--
-- Supabase SQL Editor에 통째로 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- 왜 필요한가: 자료 점검 목록에 뜨는 것 중에는 **고칠 게 없는 것**이 섞여 있습니다.
-- "첫 방문이 등록일보다 앞섭니다"는 과거 자료를 나중에 넣으면 당연히 생깁니다. 그런데
-- 목록에서 안 사라지니, 담당자가 열어볼 때마다 같은 줄을 다시 읽고 다시 판단해야 합니다.
-- 몇 번 반복되면 목록 전체를 안 보게 됩니다 — 그 안에 진짜 문제가 섞여 있어도요.
--
-- 그래서 "봤고 문제없다"를 눌러 치울 수 있게 합니다. 지우는 것이 아니라 **접어두는 것**이라,
-- 화면에서 언제든 다시 펼쳐 되돌릴 수 있습니다. 누가 언제 눌렀는지도 남습니다.

create table if not exists data_issue_checks (
  resident_id text not null,
  -- 같은 사람이라도 문제 종류가 다르면 따로 판단해야 합니다.
  kind text not null,
  checked_at timestamptz not null default now(),
  checked_by text not null default '',
  primary key (resident_id, kind)
);

alter table data_issue_checks enable row level security;

-- 어르신 자료에 관한 판단 기록이라 다른 표와 같은 기준으로 잠급니다.
drop policy if exists "data_issue_checks_read_approved" on data_issue_checks;
drop policy if exists "data_issue_checks_write_approved" on data_issue_checks;
drop policy if exists "data_issue_checks_delete_approved" on data_issue_checks;

create policy "data_issue_checks_read_approved" on data_issue_checks for select
  using ((select is_approved_user()));
create policy "data_issue_checks_write_approved" on data_issue_checks for insert
  with check ((select is_approved_user()));
create policy "data_issue_checks_delete_approved" on data_issue_checks for delete
  using ((select is_approved_user()));

-- ── 확인 ──────────────────────────────────────────────────────
select count(*) as 확인_표시된_건수 from data_issue_checks;
