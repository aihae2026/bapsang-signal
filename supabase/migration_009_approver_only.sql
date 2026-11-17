-- 가입 신청을 승인할 수 있는 사람을 지정된 계정으로만 제한합니다.
--
-- 그전까지는 "로그인한 직원 누구나" 신청 목록을 읽고 승인·반려·삭제할 수 있었습니다.
-- 가입 승인은 이 시스템에 누가 들어올 수 있는지를 정하는 일이라, 계정을 가진 모든 직원이
-- 아니라 담당자만 할 수 있어야 합니다.
--
-- ⚠️ 승인 권한을 늘리거나 줄일 때는 아래 함수 하나만 고치면 됩니다.
--    화면 쪽 목록(src/lib/requests.ts 의 APPROVER_EMAILS)도 같이 맞춰주세요.
--    화면 쪽은 탭을 감추는 용도일 뿐이고, 실제로 막는 것은 여기 이 함수입니다.

-- 로그인한 계정의 이메일이 승인 권한 목록에 있는지 봅니다.
-- 대소문자를 구분하지 않도록 양쪽 모두 소문자로 맞춰 비교합니다.
create or replace function is_access_approver() returns boolean
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) in (
    -- 메인 담당자만. 데모(시연) 계정은 일부러 넣지 않았습니다 — 심사위원에게 공유하는
    -- 계정이라, 승인 권한을 주면 그 계정을 아는 누구나 다른 사람의 가입을 승인할 수 있게
    -- 되어 권한을 제한한 의미가 없어집니다.
    -- <자리표시자> 자기 기관 승인 담당자 이메일로 바꾸세요. src/lib/requests.ts 와 같게 맞춥니다.
    'approver@example.org'
  );
$$;

-- 신청 접수는 계속 누구나 할 수 있어야 합니다(아직 계정이 없는 사람이 쓰는 기능이므로).
drop policy if exists "access_requests_insert_anon" on access_requests;
create policy "access_requests_insert_anon" on access_requests for insert with check (true);

-- 조회·승인·삭제는 승인 권한이 있는 계정만.
drop policy if exists "access_requests_read_auth" on access_requests;
drop policy if exists "access_requests_read_approver" on access_requests;
create policy "access_requests_read_approver" on access_requests for select
  using (is_access_approver());

drop policy if exists "access_requests_update_auth" on access_requests;
drop policy if exists "access_requests_update_approver" on access_requests;
create policy "access_requests_update_approver" on access_requests for update
  using (is_access_approver()) with check (is_access_approver());

drop policy if exists "access_requests_delete_auth" on access_requests;
drop policy if exists "access_requests_delete_approver" on access_requests;
create policy "access_requests_delete_approver" on access_requests for delete
  using (is_access_approver());

-- 건의·문의는 그대로 둡니다 — 직원 누구나 읽고 답변할 수 있어야 하는 내용입니다.

-- 확인: 남아 있는 정책 목록
select tablename, policyname, cmd
from pg_policies
where tablename = 'access_requests'
order by policyname;
