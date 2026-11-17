-- 실제 어르신 자료를 넣기 전에 반드시 실행해야 하는 보안 조치입니다.
--
-- 왜 지금인가: 지금까지는 목업(가짜) 자료라 구멍이 뚫려도 새어나갈 것이 없었습니다. 실제
-- 어르신 396명의 기록이 들어가는 순간, 아래 구멍들은 전부 개인정보 유출 경로가 됩니다.
--
-- ℹ️ 이메일 확인(Confirm email)은 **켜지 않습니다.**
--
--    처음에는 켜라고 안내했는데 잘못된 판단이었습니다. 무료 요금제는 메일 발송이 시간당
--    2건이라, 켜면 한 시간에 두 명밖에 가입을 못 받고 비밀번호 재설정 메일까지 같은
--    한도를 나눠 씁니다. 실무에서 쓸 수 없는 설정입니다.
--
--    켜지 않아도 되는 이유는 아래 조치들이 자물쇠를 다른 곳에 걸기 때문입니다.
--    이 파일을 적용하고 나면 모든 표의 읽기가 is_approved_user() 를 통과해야 하고,
--    그 함수는 ①기관 도메인 ②승인된 줄 을 둘 다 요구합니다. 승인 줄은 담당자만
--    만들 수 있습니다(신청은 pending 으로만 들어가고, 상태 변경은 승인자 전용).
--    그래서 이메일 확인 없이 계정을 만들어도 **볼 수 있는 자료가 하나도 없습니다.**
--
--    남는 위험은 하나뿐입니다: 아직 가입하지 않은 동료의 기관 주소로 신청서를 내면,
--    담당자가 이름만 보고 승인해버릴 수 있습니다. 이건 기술이 아니라 절차로 막습니다 —
--    승인 화면에 "본인에게 직접 확인하고 승인하세요"를 띄웁니다.
--    (거꾸로, 진짜 직원이 가입하려는데 "이미 신청된 이메일"이라고 나오면 그 자체가
--     누군가 그 주소로 신청했다는 경보입니다.)
--
--    나중에 자체 메일 서버(SMTP)를 연결하면 발송 한도가 풀리므로, 그때 켜면 됩니다.
--
-- 실행 순서: 이 파일 하나를 통째로 SQL Editor에 붙여넣고 Run. 여러 번 실행해도 안전합니다.


-- ── 1. 스스로 승인하는 길을 막습니다 ────────────────────────
--
-- 무엇이 문제였나: 가입 신청 표는 "계정 없는 사람도 신청할 수 있어야 한다"는 이유로 누구나
-- 줄을 넣을 수 있게 열려 있었습니다(with check (true)). 그런데 status 칸에 무엇을 넣을지는
-- 검사하지 않았습니다. 그래서 신청서가 아니라 **승인서**를 직접 넣을 수 있었습니다.
--
--   1) 브라우저에서 공개 키를 꺼내 access_requests 에 {email: 나, status: 'approved'} 를 넣고
--   2) 그 주소로 가입하면 (지금은 이메일 확인도 없으므로 즉시 성공)
--   3) my_access_status() 가 'approved' 를 돌려주어 어르신 자료 전부가 열립니다
--
-- 신청은 계속 누구나 할 수 있습니다. 다만 '대기' 상태로만 넣을 수 있습니다.
drop policy if exists "access_requests_insert_anon" on access_requests;
create policy "access_requests_insert_anon" on access_requests for insert
  with check (
    status = 'pending'
    and length(email) between 5 and 254
    and length(name) <= 40
    and length(note) <= 500
  );

-- 한 이메일에 줄이 여러 개면, 승인 줄을 하나 더 끼워넣는 것만으로 반려를 되살릴 수 있습니다.
-- 먼저 중복을 정리한 뒤(가장 최근 것만 남깁니다) 다시는 생기지 않게 막습니다.
delete from access_requests a
using access_requests b
where lower(a.email) = lower(b.email)
  and (a.created_at < b.created_at or (a.created_at = b.created_at and a.id < b.id));

drop index if exists access_requests_email_lower_idx;
create unique index if not exists access_requests_email_uniq
  on access_requests (lower(email));

-- 여러 줄이 남아 있을 때 "승인이 이긴다"고 해두었던 것을 뒤집습니다. 권한을 정할 때는
-- 가장 관대한 쪽이 아니라 가장 엄격한 쪽이 이겨야 합니다 — 반려 > 대기 > 승인 순으로 봅니다.
create or replace function my_access_status() returns text
language sql
security definer
set search_path = public, auth
stable
as $fn$
  select case
    when is_access_approver() then 'approved'
    else coalesce(
      (
        select r.status
        from access_requests r
        where lower(r.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        order by case r.status when 'rejected' then 0 when 'pending' then 1 else 2 end
        limit 1
      ),
      'none'
    )
  end;
$fn$;


-- ── 2. 기관 이메일 제한을 데이터베이스에 박습니다 ──────────────
--
-- 무엇이 문제였나: "@ccnoin.or.kr 계정만 쓸 수 있다"는 검사가 화면 쪽 자바스크립트에만
-- 있었습니다. 화면을 거치지 않고 가입 API를 직접 부르면 아무 주소로나 계정이 만들어집니다.
-- 화면 코드의 주석은 "실제 방어선은 DB"라고 적어두었지만, DB에는 그 조건이 없었습니다.
create or replace function enforce_org_email() returns trigger
language plpgsql
security definer
set search_path = public, auth
as $fn$
begin
  if new.email is null or lower(new.email) not like '%@ccnoin.or.kr' then
    raise exception '기관 이메일(@ccnoin.or.kr) 계정만 사용할 수 있습니다.';
  end if;
  return new;
end;
$fn$;

drop trigger if exists enforce_org_email_ins on auth.users;
create trigger enforce_org_email_ins before insert on auth.users
  for each row execute function enforce_org_email();

-- 가입한 뒤 다른 주소로 갈아타는 길도 막습니다.
drop trigger if exists enforce_org_email_upd on auth.users;
create trigger enforce_org_email_upd before update of email on auth.users
  for each row when (new.email is distinct from old.email)
  execute function enforce_org_email();

-- 승인 판정에도 도메인 조건을 겹칩니다. 한 겹이 뚫려도 다른 겹이 남도록.
create or replace function is_approved_user() returns boolean
language sql
security definer
set search_path = public, auth
stable
as $fn$
  select auth.role() = 'authenticated'
     and lower(coalesce(auth.jwt() ->> 'email', '')) like '%@ccnoin.or.kr'
     and my_access_status() = 'approved';
$fn$;

-- 승인 권한 함수에 search_path 고정이 빠져 있었습니다. 다른 함수는 전부 고정해두었는데
-- 이것만 빠져서, 호출하는 쪽 설정에 따라 다른 함수가 불릴 여지가 남아 있었습니다.
alter function is_access_approver() set search_path = public, auth;


-- ── 3. 건의·문의를 승인된 직원만 보게 합니다 ──────────────────
--
-- 무엇이 문제였나: 이 표만 "로그인했으면 누구나"로 남겨두었습니다. 그때는 공개 가입이
-- 꺼져 있어서 로그인한 사람 = 기관 직원이었습니다. 그런데 자율 가입을 열면서 그 전제가
-- 깨졌습니다 — 이제 로그인한 사람은 "가입 버튼을 누른 아무나"입니다.
--
-- 건의·문의 본문에는 어르신 상황과 직원 실명이 자유 서술로 들어갑니다.
drop policy if exists "suggestions_read_auth" on suggestions;
drop policy if exists "suggestions_update_auth" on suggestions;
drop policy if exists "suggestions_delete_auth" on suggestions;
drop policy if exists "suggestions_read_approved" on suggestions;
drop policy if exists "suggestions_update_approved" on suggestions;
drop policy if exists "suggestions_delete_approved" on suggestions;

create policy "suggestions_read_approved" on suggestions for select
  using ((select is_approved_user()));
create policy "suggestions_update_approved" on suggestions for update
  using ((select is_approved_user())) with check ((select is_approved_user()));
create policy "suggestions_delete_approved" on suggestions for delete
  using ((select is_approved_user()));

-- 접수는 계속 누구나. 다만 답변 칸과 처리 상태를 신청자가 미리 채워넣지 못하게 하고,
-- 길이도 제한합니다(수 MB짜리 글을 수만 건 밀어넣어 마비시키는 것을 막습니다).
drop policy if exists "suggestions_insert_anon" on suggestions;
create policy "suggestions_insert_anon" on suggestions for insert
  with check (
    status = 'open'
    and reply = ''
    and length(text) between 1 and 2000
    and length(author) <= 40
  );


-- ── 4. 어르신 사진 버킷을 비공개로 돌립니다 ────────────────────
--
-- 무엇이 문제였나: storage.objects 에 "승인된 직원만"이라는 정책을 촘촘히 걸어두었지만,
-- 버킷 자체가 공개(public)로 만들어져 있었습니다. 공개 버킷의 /object/public/ 주소는
-- 그 정책을 아예 거치지 않습니다. 즉 주소만 알면 로그인 없이, 승인을 취소해도, 계정을
-- 지워도 영구히 어르신 얼굴 사진을 내려받을 수 있었습니다.
--
-- 지금은 올라간 사진이 0장이라 지금 잠그는 것이 가장 쌉니다.
update storage.buckets set public = false where id = 'resident-photos';


-- ── 5. 확인 ────────────────────────────────────────────────
select 'access_requests 정책' as 항목, policyname, cmd, coalesce(with_check, qual) as 조건
from pg_policies where tablename = 'access_requests'
union all
select 'suggestions 정책', policyname, cmd, coalesce(with_check, qual)
from pg_policies where tablename = 'suggestions'
order by 1, 3;

select id as 버킷, public as 공개여부 from storage.buckets where id = 'resident-photos';
select tgname as 트리거 from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;
