-- ⚠️⚠️ 이 파일을 **절대 다시 실행하지 마십시오.** 최초 설치 한 번만 유효합니다.
--
--    머리말이 「보안 강화」라서 보안을 조이려고 다시 돌리기 쉬운데, 지금은 정반대입니다.
--    아래가 여는 것 —
--      residents · attendance · staff · holidays  → select using (true)
--      resident-photos 버킷                        → 인증 조건 없는 읽기
--    이 이름들은 migration_010 이 전부 drop 했으므로 운영 DB 에 지금은 없습니다.
--    다시 실행하면 전부 새로 생기고, RLS 정책은 OR 로 합쳐지므로 012·014 의 승인 잠금이
--    **무력화됩니다.** anon 키는 설계상 브라우저 번들에 들어 있어 누구나 부를 수 있습니다.
--    005 는 확인 기록 하나지만, 이 파일은 **어르신 명단·출결·직원·휴관일·사진 전부**입니다.
--
--    ⚠️ 아래 memos 관련 세 줄(20~22)을 「죽은 코드」라고 지우지 마십시오.
--       migration_025 가 memos 표를 지웠기 때문에, 그 줄에서 에러가 나 이 스크립트가
--       통째로 롤백되는 것이 **지금 재실행을 막고 있는 유일한 장치**입니다.
--
-- 보안 강화: "조회는 누구나(심사위원 등 외부인 포함) 가능, 추가/수정/삭제는 로그인한 직원만"으로 분리
-- 기존 정책은 anon 키만 있으면 조회/추가/수정/삭제가 전부 가능했습니다(러버블 보안 스캔 critical 3건의 원인).

-- residents
drop policy if exists "residents_all_anon" on residents;
create policy "residents_read_anon" on residents for select using (true);
create policy "residents_insert_auth" on residents for insert with check (auth.role() = 'authenticated');
create policy "residents_update_auth" on residents for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "residents_delete_auth" on residents for delete using (auth.role() = 'authenticated');

-- attendance
drop policy if exists "attendance_all_anon" on attendance;
create policy "attendance_read_anon" on attendance for select using (true);
create policy "attendance_insert_auth" on attendance for insert with check (auth.role() = 'authenticated');
create policy "attendance_update_auth" on attendance for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "attendance_delete_auth" on attendance for delete using (auth.role() = 'authenticated');

-- memos
drop policy if exists "memos_all_anon" on memos;
create policy "memos_read_anon" on memos for select using (true);
create policy "memos_insert_auth" on memos for insert with check (auth.role() = 'authenticated');
create policy "memos_update_auth" on memos for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "memos_delete_auth" on memos for delete using (auth.role() = 'authenticated');

-- staff
drop policy if exists "staff_all_anon" on staff;
create policy "staff_read_anon" on staff for select using (true);
create policy "staff_insert_auth" on staff for insert with check (auth.role() = 'authenticated');
create policy "staff_delete_auth" on staff for delete using (auth.role() = 'authenticated');

-- holidays (외부변수)
drop policy if exists "holidays_all_anon" on holidays;
create policy "holidays_read_anon" on holidays for select using (true);
create policy "holidays_insert_auth" on holidays for insert with check (auth.role() = 'authenticated');
create policy "holidays_delete_auth" on holidays for delete using (auth.role() = 'authenticated');

-- 어르신 사진 스토리지: 조회는 공개, 업로드/수정/삭제는 로그인한 직원만
drop policy if exists "resident_photos_all_anon" on storage.objects;
create policy "resident_photos_read_anon" on storage.objects for select
  using (bucket_id = 'resident-photos');
create policy "resident_photos_insert_auth" on storage.objects for insert
  with check (bucket_id = 'resident-photos' and auth.role() = 'authenticated');
create policy "resident_photos_update_auth" on storage.objects for update
  using (bucket_id = 'resident-photos' and auth.role() = 'authenticated')
  with check (bucket_id = 'resident-photos' and auth.role() = 'authenticated');
create policy "resident_photos_delete_auth" on storage.objects for delete
  using (bucket_id = 'resident-photos' and auth.role() = 'authenticated');
