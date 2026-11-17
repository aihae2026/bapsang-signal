-- 조회가 갑자기 느려진 것을 고칩니다. Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
--
-- 무엇이 잘못됐나: migration_010 에서 정책을 using (is_approved_user()) 로 썼습니다.
-- RLS 정책은 행마다 평가되므로, 출석 7,450행을 읽으면 이 함수가 7,450번 불리고 매번
-- access_requests 표를 다시 조회합니다. 실제 자료 82,085행이면 8만 번입니다.
--
-- 고치는 방법: 함수 호출을 (select ...) 로 감쌉니다. PostgreSQL이 쿼리 시작 시 한 번만
-- 계산해두고(InitPlan) 모든 행에 재사용합니다. 판정 결과는 같습니다 — 로그인한 사람이
-- 승인됐는지는 행마다 달라질 수 있는 값이 아닙니다.
--
-- 처음에는 do 블록으로 반복문을 썼는데, SQL 편집기에서 달러 기호 블록이 잘려 들어가
-- "syntax error at end of input" 이 났습니다. 그래서 반복문 없이 문장을 그대로 나열합니다.

create index if not exists access_requests_email_lower_idx
  on access_requests (lower(email));

drop policy if exists "residents_read_approved" on residents;
drop policy if exists "residents_insert_approved" on residents;
drop policy if exists "residents_update_approved" on residents;
drop policy if exists "residents_delete_approved" on residents;
drop policy if exists "attendance_read_approved" on attendance;
drop policy if exists "attendance_insert_approved" on attendance;
drop policy if exists "attendance_update_approved" on attendance;
drop policy if exists "attendance_delete_approved" on attendance;
drop policy if exists "memos_read_approved" on memos;
drop policy if exists "memos_insert_approved" on memos;
drop policy if exists "memos_update_approved" on memos;
drop policy if exists "memos_delete_approved" on memos;
drop policy if exists "staff_read_approved" on staff;
drop policy if exists "staff_insert_approved" on staff;
drop policy if exists "staff_update_approved" on staff;
drop policy if exists "staff_delete_approved" on staff;
drop policy if exists "holidays_read_approved" on holidays;
drop policy if exists "holidays_insert_approved" on holidays;
drop policy if exists "holidays_update_approved" on holidays;
drop policy if exists "holidays_delete_approved" on holidays;
drop policy if exists "followups_read_approved" on followups;
drop policy if exists "followups_insert_approved" on followups;
drop policy if exists "followups_update_approved" on followups;
drop policy if exists "followups_delete_approved" on followups;

create policy "residents_read_approved" on residents for select
  using ((select is_approved_user()));
create policy "residents_insert_approved" on residents for insert
  with check ((select is_approved_user()));
create policy "residents_update_approved" on residents for update
  using ((select is_approved_user())) with check ((select is_approved_user()));
create policy "residents_delete_approved" on residents for delete
  using ((select is_approved_user()));

create policy "attendance_read_approved" on attendance for select
  using ((select is_approved_user()));
create policy "attendance_insert_approved" on attendance for insert
  with check ((select is_approved_user()));
create policy "attendance_update_approved" on attendance for update
  using ((select is_approved_user())) with check ((select is_approved_user()));
create policy "attendance_delete_approved" on attendance for delete
  using ((select is_approved_user()));

create policy "memos_read_approved" on memos for select
  using ((select is_approved_user()));
create policy "memos_insert_approved" on memos for insert
  with check ((select is_approved_user()));
create policy "memos_update_approved" on memos for update
  using ((select is_approved_user())) with check ((select is_approved_user()));
create policy "memos_delete_approved" on memos for delete
  using ((select is_approved_user()));

create policy "staff_read_approved" on staff for select
  using ((select is_approved_user()));
create policy "staff_insert_approved" on staff for insert
  with check ((select is_approved_user()));
create policy "staff_update_approved" on staff for update
  using ((select is_approved_user())) with check ((select is_approved_user()));
create policy "staff_delete_approved" on staff for delete
  using ((select is_approved_user()));

create policy "holidays_read_approved" on holidays for select
  using ((select is_approved_user()));
create policy "holidays_insert_approved" on holidays for insert
  with check ((select is_approved_user()));
create policy "holidays_update_approved" on holidays for update
  using ((select is_approved_user())) with check ((select is_approved_user()));
create policy "holidays_delete_approved" on holidays for delete
  using ((select is_approved_user()));

create policy "followups_read_approved" on followups for select
  using ((select is_approved_user()));
create policy "followups_insert_approved" on followups for insert
  with check ((select is_approved_user()));
create policy "followups_update_approved" on followups for update
  using ((select is_approved_user())) with check ((select is_approved_user()));
create policy "followups_delete_approved" on followups for delete
  using ((select is_approved_user()));

drop policy if exists "resident_photos_read_approved" on storage.objects;
drop policy if exists "resident_photos_insert_approved" on storage.objects;
drop policy if exists "resident_photos_update_approved" on storage.objects;
drop policy if exists "resident_photos_delete_approved" on storage.objects;

create policy "resident_photos_read_approved" on storage.objects for select
  using (bucket_id = 'resident-photos' and (select is_approved_user()));
create policy "resident_photos_insert_approved" on storage.objects for insert
  with check (bucket_id = 'resident-photos' and (select is_approved_user()));
create policy "resident_photos_update_approved" on storage.objects for update
  using (bucket_id = 'resident-photos' and (select is_approved_user()))
  with check (bucket_id = 'resident-photos' and (select is_approved_user()));
create policy "resident_photos_delete_approved" on storage.objects for delete
  using (bucket_id = 'resident-photos' and (select is_approved_user()));

drop policy if exists "app_settings_read_approved" on app_settings;
drop policy if exists "app_settings_write_approved" on app_settings;
drop policy if exists "app_settings_update_approved" on app_settings;

create policy "app_settings_read_approved" on app_settings for select
  using ((select is_approved_user()));
create policy "app_settings_write_approved" on app_settings for insert
  with check ((select is_approved_user()));
create policy "app_settings_update_approved" on app_settings for update
  using ((select is_approved_user())) with check ((select is_approved_user()));

drop policy if exists "access_requests_read_approver" on access_requests;
drop policy if exists "access_requests_update_approver" on access_requests;
drop policy if exists "access_requests_delete_approver" on access_requests;

create policy "access_requests_read_approver" on access_requests for select
  using ((select is_access_approver()));
create policy "access_requests_update_approver" on access_requests for update
  using ((select is_access_approver())) with check ((select is_access_approver()));
create policy "access_requests_delete_approver" on access_requests for delete
  using ((select is_access_approver()));

select tablename, cmd, policyname, qual
from pg_policies
where tablename in ('residents', 'attendance', 'memos', 'app_settings')
  and cmd = 'SELECT'
order by tablename;
