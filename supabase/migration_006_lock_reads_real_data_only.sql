-- ════════════════════════════════════════════════════════════════════
-- ⛔ 이 파일은 **이미 할 일을 마쳤습니다. 다시 실행하지 마십시오.**
-- ════════════════════════════════════════════════════════════════════
--
-- 왜 위험한가:
--
--   아래 정책들은 조건이 「로그인했는가(auth.role() = 'authenticated')」 하나입니다.
--   그런데 지금 DB 에 걸려 있는 것은 migration_012 의 `*_read_approved` —
--   「기관 메일로 가입했고 **관리자 승인까지 받았는가**(is_approved_user())」입니다.
--
--   **Postgres 는 같은 표의 정책을 OR 로 합칩니다.** 이 파일을 다시 돌리면
--   `*_read_auth` 가 나란히 생기고, 승인 검사가 통째로 무력화됩니다 —
--   `@ccnoin.or.kr` 주소로 가입만 해두고 **승인을 못 받았거나 반려당한 계정도**
--   어르신 405명의 명단·전화번호·확인 기록·사진을 전부 내려받게 됩니다.
--
--   아래 `drop policy` 들은 **예전 이름(`*_read_anon`)만 지웁니다.** 지금 걸려 있는
--   `*_read_approved` 는 건드리지 않으므로, 지운다고 안전해지지 않습니다.
--
-- 그래서 남겨 두는가:
--
--   기록이기 때문입니다. 「대회 심사용으로 조회를 열어 두었다가 실제 어르신 자료를
--   넣는 날 잠갔다」는 사실이 이 파일에 남아 있습니다. 지우면 그 판단이 사라집니다.
--
--   30행의 `memos` 참조는 **일부러 남겨 둡니다.** migration_025 가 그 표를 지웠기
--   때문에, 실수로 이 파일을 실행해도 거기서 에러가 나 전체가 롤백됩니다.
--   죽은 코드처럼 보이지만 안전장치입니다 — 정리한다고 지우지 마십시오.
--
-- 지금 상태를 확인하려면: supabase/security_check_live_state.sql 을 실행하십시오.
--   (읽기만 하고 아무것도 바꾸지 않습니다)
--
-- ── 아래는 2026년 당시 원본입니다. 기록용으로만 둡니다 ──────────────
--
--   ⚠️ 지금 실행하지 마세요. 실제 어르신 데이터를 넣기로 결정한 날에만 실행합니다.
--   
--   무엇을 하는 파일인가:
--   현재 조회(select)는 로그인 없이 누구나 가능합니다. 대회 심사위원이 배포 링크를
--   그냥 열어볼 수 있게 하려고 의도적으로 열어둔 설정입니다. 가명 더미 데이터일 때는
--   문제가 없지만, 실명·전화번호·건강 상태가 들어가면 anon 키(배포된 자바스크립트에
--   그대로 들어있음)만으로 명단 전체를 내려받을 수 있게 됩니다.
--   
--   이 파일은 조회 권한을 "로그인한 직원만"으로 바꿉니다.
--   
--   실행하면 어떻게 되는가:
--   로그인하지 않은 사람에게는 대시보드·리포트가 전부 빈 화면이 됩니다.
--   → 심사위원용 데모 링크가 그 즉시 작동하지 않습니다.
--   → 심사에 쓸 화면은 가명 데이터를 쓰는 별도 프로젝트로 분리하거나,
--   심사위원용 계정을 발급해 전달해야 합니다.
--   
--   되돌리려면: 아래 auth.role() = 'authenticated' 부분을 true 로 바꿔 다시 실행하세요.

-- residents
drop policy if exists "residents_read_anon" on residents;
create policy "residents_read_auth" on residents for select
  using (auth.role() = 'authenticated');

-- attendance
drop policy if exists "attendance_read_anon" on attendance;
create policy "attendance_read_auth" on attendance for select
  using (auth.role() = 'authenticated');

-- memos (관찰 기록 — 가장 민감합니다)
drop policy if exists "memos_read_anon" on memos;
create policy "memos_read_auth" on memos for select
  using (auth.role() = 'authenticated');

-- staff
drop policy if exists "staff_read_anon" on staff;
create policy "staff_read_auth" on staff for select
  using (auth.role() = 'authenticated');

-- holidays (외부변수 — 개인정보는 아니지만 일관성을 위해 함께 잠급니다)
drop policy if exists "holidays_read_anon" on holidays;
create policy "holidays_read_auth" on holidays for select
  using (auth.role() = 'authenticated');

-- followups (대응 이력)
drop policy if exists "followups_read_anon" on followups;
create policy "followups_read_auth" on followups for select
  using (auth.role() = 'authenticated');

-- 어르신 사진 스토리지
drop policy if exists "resident_photos_read_anon" on storage.objects;
create policy "resident_photos_read_auth" on storage.objects for select
  using (bucket_id = 'resident-photos' and auth.role() = 'authenticated');
