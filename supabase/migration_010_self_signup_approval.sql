-- 신청자가 비밀번호를 직접 정하고, 담당자가 승인하면 그 비밀번호로 바로 들어오게 합니다.
-- Supabase SQL Editor에서 실행하세요. 여러 번 실행해도 안전합니다.
--
-- ── 왜 이 구조인가 ─────────────────────────────────────────
-- 신청 양식에 비밀번호 칸을 넣되, 그 값을 access_requests 표에 넣지는 않습니다. 표에 넣으면
-- 그 표를 읽을 수 있는 사람이 남의 비밀번호를 평문으로 보게 되고, 백업·로그 어디에든 그대로
-- 남습니다. 비밀번호는 Supabase Auth로 곧장 보내 해시로만 보관되게 합니다.
--
-- 그래서 "계정이 있다"와 "볼 권한이 있다"를 분리했습니다:
--
--   1. 신청자가 이메일 + 본인이 정한 비밀번호로 계정을 만듭니다 (auth.signUp)
--   2. 아래 트리거가 access_requests에 status='pending' 신청서를 자동으로 남깁니다
--   3. 이 상태로 로그인은 되지만 어떤 표도 읽히지 않습니다 → 화면은 "승인 대기"
--   4. 담당자가 승인하면 status='approved' → 그때부터 데이터가 보입니다
--
-- 즉 승인은 계정을 만들어주는 일이 아니라, 이미 있는 계정의 문을 열어주는 일이 됩니다.
-- 담당자가 비밀번호를 대신 만들어 카톡·구두로 전달할 일이 없어집니다.
--
-- ⚠️ 이 파일을 실행한 뒤 Supabase 설정을 바꿔야 합니다:
--    Authentication → Sign In / Providers → User Signups
--    → "Allow new users to sign up" 을 **켜세요**.
--    그동안 꺼두려 했던 이유(아무나 가입해서 데이터를 보는 것)는 아래 4번 정책이 막아줍니다.

-- ── 1. 승인 여부를 판정하는 함수 ───────────────────────────
--
-- security definer 인 이유: access_requests 는 담당자만 읽을 수 있게 잠겨 있습니다. 그런데
-- 이 함수는 "내가 승인됐는지"를 본인이 확인할 때도 불려야 합니다. definer 로 두면 함수가
-- 표를 대신 읽어주고, 호출한 사람은 자기 상태 한 줄만 돌려받습니다.
--
-- search_path 를 고정한 이유: definer 함수는 만든 사람(postgres) 권한으로 돕니다. 경로를
-- 열어두면 누군가 같은 이름의 표를 다른 스키마에 만들어 함수를 속일 수 있습니다.

create or replace function my_access_status() returns text
language sql
security definer
set search_path = public, auth
stable
as $fn$
  select case
    -- 담당자는 항상 통과합니다. 승인 표에 문제가 생겨도 스스로를 잠가버리지 않도록.
    when is_access_approver() then 'approved'
    else coalesce(
      (
        select r.status
        from access_requests r
        where lower(r.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        -- 한 사람 이름으로 여러 줄이 있으면 승인이 이깁니다.
        order by case r.status when 'approved' then 0 when 'pending' then 1 else 2 end
        limit 1
      ),
      'none'
    )
  end;
$fn$;

create or replace function is_approved_user() returns boolean
language sql
security definer
set search_path = public, auth
stable
as $fn$
  select auth.role() = 'authenticated' and my_access_status() = 'approved';
$fn$;

grant execute on function my_access_status() to anon, authenticated;
grant execute on function is_approved_user() to anon, authenticated;

-- ── 2. 가입하면 신청서가 자동으로 남게 ─────────────────────
--
-- 화면에서 신청서를 따로 넣지 않고 트리거로 남기는 이유: 계정은 만들어졌는데 신청서 저장이
-- 실패하면, 로그인은 되지만 담당자 목록에는 안 뜨는 계정이 생깁니다. 트리거로 두면 계정과
-- 신청서가 한 트랜잭션에 함께 생기므로 그런 짝 잃은 계정이 생기지 않습니다.
--
-- 이미 같은 이메일의 신청서가 있으면 그대로 둡니다 — 예전 방식으로 신청했다가 이제 가입하는
-- 경우에 승인 상태를 덮어써버리면 안 됩니다.

create or replace function handle_new_auth_user() returns trigger
language plpgsql
security definer
set search_path = public, auth
as $fn$
begin
  if new.email is null then
    return new;
  end if;

  insert into access_requests (id, email, name, note, status)
  select
    'ar-signup-' || new.id::text,
    lower(new.email),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), ''),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'note'), ''), ''),
    'pending'
  where not exists (
    select 1 from access_requests r where lower(r.email) = lower(new.email)
  );

  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ── 3. 지금 있는 계정은 모두 승인 처리 ─────────────────────
--
-- 트리거는 앞으로 만들어지는 계정에만 걸립니다. 이 파일을 실행하는 순간 이미 쓰고 있는
-- 계정들(담당자·직원·데모 계정)은 신청서가 없어 'none'이 되고, 다음 새로고침에 전부
-- 잠깁니다. 그래서 여기서 한 번 승인 상태로 넣어둡니다.

insert into access_requests (id, email, name, note, status)
select
  'ar-existing-' || u.id::text,
  lower(u.email),
  coalesce(nullif(trim(u.raw_user_meta_data ->> 'name'), ''), ''),
  '기존 사용 계정 — 이 정책 도입 시 자동 승인',
  'approved'
from auth.users u
where u.email is not null
  and not exists (
    select 1 from access_requests r where lower(r.email) = lower(u.email)
  );

-- ── 4. 승인된 계정만 데이터를 보고 쓰게 ────────────────────
--
-- 가입을 열면 "로그인했다"는 사실만으로는 더 이상 아무 보증이 되지 않습니다. 아무 이메일로
-- 계정을 만들면 그 순간 authenticated 가 되기 때문입니다. 그래서 조회는 물론 추가·수정·
-- 삭제까지 전부 is_approved_user() 로 바꿉니다. 쓰기를 함께 바꾸는 게 특히 중요합니다 —
-- 그대로 두면 방금 가입한 아무나가 어르신 명단을 지울 수 있습니다.

do $mig$
declare
  t text;
begin
  for t in
    select unnest(array['residents', 'attendance', 'memos', 'staff', 'holidays', 'followups'])
  loop
    -- 이전 단계들에서 만들어진 이름을 모두 걷어냅니다(파일마다 이름이 달랐습니다).
    execute format('drop policy if exists %I on %I', t || '_read_anon', t);
    execute format('drop policy if exists %I on %I', t || '_read_auth', t);
    execute format('drop policy if exists %I on %I', t || '_insert_auth', t);
    execute format('drop policy if exists %I on %I', t || '_update_auth', t);
    execute format('drop policy if exists %I on %I', t || '_delete_auth', t);
    execute format('drop policy if exists %I on %I', t || '_read_approved', t);
    execute format('drop policy if exists %I on %I', t || '_insert_approved', t);
    execute format('drop policy if exists %I on %I', t || '_update_approved', t);
    execute format('drop policy if exists %I on %I', t || '_delete_approved', t);

    execute format(
      'create policy %I on %I for select using (is_approved_user())',
      t || '_read_approved', t);
    execute format(
      'create policy %I on %I for insert with check (is_approved_user())',
      t || '_insert_approved', t);
    execute format(
      'create policy %I on %I for update using (is_approved_user()) with check (is_approved_user())',
      t || '_update_approved', t);
    execute format(
      'create policy %I on %I for delete using (is_approved_user())',
      t || '_delete_approved', t);
  end loop;
end $mig$;

-- 어르신 사진 스토리지도 같이.
drop policy if exists "resident_photos_read_anon" on storage.objects;
drop policy if exists "resident_photos_read_auth" on storage.objects;
drop policy if exists "resident_photos_insert_auth" on storage.objects;
drop policy if exists "resident_photos_update_auth" on storage.objects;
drop policy if exists "resident_photos_delete_auth" on storage.objects;
drop policy if exists "resident_photos_read_approved" on storage.objects;
drop policy if exists "resident_photos_insert_approved" on storage.objects;
drop policy if exists "resident_photos_update_approved" on storage.objects;
drop policy if exists "resident_photos_delete_approved" on storage.objects;

create policy "resident_photos_read_approved" on storage.objects for select
  using (bucket_id = 'resident-photos' and is_approved_user());
create policy "resident_photos_insert_approved" on storage.objects for insert
  with check (bucket_id = 'resident-photos' and is_approved_user());
create policy "resident_photos_update_approved" on storage.objects for update
  using (bucket_id = 'resident-photos' and is_approved_user())
  with check (bucket_id = 'resident-photos' and is_approved_user());
create policy "resident_photos_delete_approved" on storage.objects for delete
  using (bucket_id = 'resident-photos' and is_approved_user());

-- 건의·문의(suggestions)는 그대로 둡니다 — 계정이 없는 사람도 쓸 수 있어야 하고, 직원
-- 누구나 읽고 답변할 수 있어야 하는 내용입니다.

-- ── 5. 확인 ────────────────────────────────────────────────
-- (가) 지금 계정들이 모두 승인 상태로 들어갔는지 (승인상태가 전부 approved 여야 정상)
select u.email, coalesce(r.status, '신청서없음') as 승인상태
from auth.users u
left join access_requests r on lower(r.email) = lower(u.email)
where u.email is not null
order by u.email;

-- (나) 정책 이름이 _approved 로 바뀌었는지 (표 6개 × 4줄 = 24줄이 나와야 정상)
select tablename, cmd, policyname
from pg_policies
where tablename in ('residents', 'attendance', 'memos', 'staff', 'holidays', 'followups')
order by tablename, cmd, policyname;
