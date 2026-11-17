-- ════════════════════════════════════════════════════════════════════
-- 보안 점검 — 지금 데이터베이스가 실제로 어떤 상태인지 읽어만 봅니다
-- ════════════════════════════════════════════════════════════════════
--
-- 왜 필요한가:
--
--   러버블(Lovable) 보안 검사가 Critical 3건을 띄웠습니다 —
--     · 관리자 화면이 화면단 검사로만 막혀 있다
--     · 어르신 개인정보·돌봄 기록이 열려 있다
--     · 어르신 사진을 누구나 읽고 쓸 수 있다
--
--   세 건 모두 **migration_002 · migration_003 파일을 읽고 낸 판정**입니다.
--   그 파일들은 처음 만들 때의 상태(public 버킷, using(true) 정책)를 담고 있고,
--   004 · 006 · 010 · 012 · 014 가 그 뒤로 전부 잠갔습니다. 검사기는 폴더에 남아 있는
--   옛 파일을 보고 "지금도 그렇다"고 말한 것입니다.
--
--   다만 **파일이 잠갔다고 DB 가 잠긴 것은 아닙니다.** 그 마이그레이션들을 실제로
--   돌렸는지는 DB 에 물어봐야 압니다. 이 파일이 그걸 물어봅니다.
--
--   읽기만 합니다. 아무것도 바꾸지 않습니다.
--
-- 보는 법: 「결과」 칸에 🔴 가 하나도 없으면 러버블 경고 3건은 전부 오탐입니다.
--          🔴 가 하나라도 있으면 그건 진짜입니다.
--
-- 실행: Supabase 대시보드 → SQL Editor → 붙여넣고 Run
--       (네 가지를 한 번에 보려고 하나의 질의로 묶어 두었습니다)
-- ════════════════════════════════════════════════════════════════════

with 점검결과 as (

  -- ① 사진 보관함이 공개인가 ───────────────────────────────────────
  --    비공개여야 합니다. 공개면 주소만 알면 누구나 어르신 사진을 봅니다.
  select 1 as 순,
         '① 사진 보관함'                   as "점검",
         id::text                          as "대상",
         '공개 여부'                       as "상세",
         case when public then '🔴 공개 — 위험' else '🟢 비공개' end as "결과"
    from storage.buckets
   where id in ('resident-photos', 'resources')

  union all

  -- ② 어르신 자료를 누가 읽을 수 있나 ──────────────────────────────
  --    정책 조건에 is_approved_user 가 들어 있어야 합니다.
  --    조건이 true 뿐이면 로그인 없이 누구나 읽습니다.
  select 2,
         '② 자료 접근 정책',
         tablename::text,
         policyname::text || ' / ' || cmd::text,
         case
           when coalesce(qual, '') ilike '%is_approved_user%'
             or coalesce(with_check, '') ilike '%is_approved_user%'
             then '🟢 승인된 직원만'
           when coalesce(qual, with_check) = 'true'
             then '🔴 누구나 — 위험'
           else '⚪ 직접 확인: ' || coalesce(qual, with_check, '(조건 없음)')
         end
    from pg_policies
   where schemaname = 'public'
     and tablename in ('residents', 'attendance', 'followups',
                       'staff', 'holidays', 'member_state')

  union all

  -- ③ RLS 자체가 켜져 있나 ─────────────────────────────────────────
  --    RLS 가 꺼져 있으면 정책을 아무리 잘 짜도 전부 무시됩니다.
  select 3,
         '③ RLS 켜짐',
         relname::text,
         '행 수준 보안',
         case when relrowsecurity then '🟢 켜짐' else '🔴 꺼짐 — 정책 전부 무효' end
    from pg_class
   where relnamespace = 'public'::regnamespace
     and relkind = 'r'
     and relname in ('residents', 'attendance', 'followups', 'staff',
                     'holidays', 'member_state', 'app_settings', 'access_requests')

  union all

  -- ④ 사진 보관함 정책 ─────────────────────────────────────────────
  select 4,
         '④ 사진 정책',
         policyname::text,
         cmd::text,
         case
           when coalesce(qual, '') ilike '%is_approved_user%'
             or coalesce(with_check, '') ilike '%is_approved_user%'
             then '🟢 승인된 직원만'
           when coalesce(qual, '') ilike '%anon%' or coalesce(qual, '') = 'true'
             then '🔴 누구나 — 위험'
           else '⚪ 직접 확인'
         end
    from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
)
select "점검", "대상", "상세", "결과"
  from 점검결과
 order by 순, "대상", "상세";
