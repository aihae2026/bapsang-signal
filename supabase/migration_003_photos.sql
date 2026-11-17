-- ⚠️ 이 파일을 다시 실행하지 마십시오. 최초 설치 한 번만 유효합니다.
--
--    아래 resident_photos_all_anon 은 `for all` 이고 **인증 조건이 없습니다** —
--    어르신 사진 버킷을 익명 읽기·쓰기·삭제로 엽니다. migration_004 가 이 정책을 떼어내고
--    014 가 버킷을 비공개로 되돌리는데, 이 파일을 다시 돌리면 그 잠금이 풀립니다.
--    RLS 정책은 OR 로 합쳐지기 때문입니다.
--
-- 어르신 실물 사진 지원: photo_url 컬럼 + Storage 버킷 추가

alter table residents
  add column if not exists photo_url text;

insert into storage.buckets (id, name, public)
values ('resident-photos', 'resident-photos', true)
on conflict (id) do nothing;

create policy "resident_photos_all_anon" on storage.objects for all
  using (bucket_id = 'resident-photos')
  with check (bucket_id = 'resident-photos');
