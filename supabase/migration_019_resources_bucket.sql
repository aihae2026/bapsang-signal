-- 자료실(파일 올리기 · 엔컴 자동화 프로그램 내려받기)용 Storage 버킷.
--
-- Supabase SQL Editor에 통째로 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- ⚠️ 비공개(public = false) 버킷입니다.
--    공개 버킷의 /object/public/ 주소는 접근 정책을 아예 거치지 않아, 주소만 알면 로그인
--    없이 영원히 내려받힙니다. 올리는 파일에 어르신 급식 자료(엑셀)가 들어올 수 있으므로
--    반드시 비공개로 두고, 화면에서는 짧게 만료되는 서명 URL로만 내려받게 합니다.

-- ── 1. 버킷 생성 ──────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('resources', 'resources', false)
on conflict (id) do update set public = false;

-- ── 2. 승인된 직원만 읽고·올리고·지울 수 있게 ─────────────────
-- is_approved_user() 는 migration_010/014 에서 만든 함수입니다
-- (기관 이메일 + 승인된 신청서 두 가지를 모두 요구합니다).
drop policy if exists "resources_read_approved" on storage.objects;
drop policy if exists "resources_insert_approved" on storage.objects;
drop policy if exists "resources_update_approved" on storage.objects;
drop policy if exists "resources_delete_approved" on storage.objects;

create policy "resources_read_approved" on storage.objects for select
  using (bucket_id = 'resources' and is_approved_user());
create policy "resources_insert_approved" on storage.objects for insert
  with check (bucket_id = 'resources' and is_approved_user());
create policy "resources_update_approved" on storage.objects for update
  using (bucket_id = 'resources' and is_approved_user())
  with check (bucket_id = 'resources' and is_approved_user());
create policy "resources_delete_approved" on storage.objects for delete
  using (bucket_id = 'resources' and is_approved_user());

-- ── 3. 확인 ──────────────────────────────────────────────────
select id as 버킷, public as 공개여부 from storage.buckets where id = 'resources';
select policyname, cmd from pg_policies
where tablename = 'objects' and policyname like 'resources_%'
order by policyname;
