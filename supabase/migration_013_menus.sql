-- 식단표를 담는 표. Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
--
-- ── 왜 식단이 필요한가 ─────────────────────────────────────
-- 설계근거 문서 3.3의 메뉴 선호도 변수입니다. 해외 실증이 가장 탄탄한 변수 중 하나입니다
-- (텍사스 집합급식 프로그램 연구 · 미국 ACL 자료: 메뉴가 마음에 안 들면 다시 오지 않음).
--
-- 그런데 "맛있다/없다"는 사람마다 다릅니다. 그래서 아무에게도 묻지 않습니다 — 어느 메뉴가
-- 좋았는지는 그날 몇 분이 오셨는지가 이미 말해줍니다. 사람이 라벨을 붙이는 순간 주관이
-- 들어가므로, 판정은 출석 자료에 맡깁니다.
--
-- 그리고 특식 여부는 판정할 필요조차 없었습니다. 식단표에 이미 적혀 있습니다 —
-- 2026년 7월 식단표에는 7/8에 「무료급식 행사」, 7/15에 「초복」이 그림으로 붙어 있고,
-- 그 두 날 실제 출석이 828명·752명(평소 396명의 2.1배·1.9배)이었습니다. event 칸이 그것입니다.
--
-- ⚠️ 순서가 중요합니다. 특식을 "출석이 급증한 날"로 정하고 그 특식으로 출석을 설명하면
--    순환논리입니다. 특식은 반드시 식단표(입력)에서 읽어야 하고, 출석은 그 뒤에 봅니다.

create table if not exists menus (
  -- 하루에 한 끼라 날짜가 열쇠입니다.
  date date primary key,
  -- 메뉴 전체를 줄바꿈으로 구분해 그대로 담습니다. 항목별로 쪼개지 않은 이유: 식단표의
  -- 표기가 "올방개묵/양념간장", "상추&깻잎&편마늘&쌈장" 처럼 일정하지 않아, 쪼개려면
  -- 규칙을 만들어야 하고 그 규칙이 원본을 왜곡합니다. 원문을 남기고 필요할 때 읽습니다.
  menu text not null default '',
  kcal int,
  protein_g int,
  -- 식단표에 그림으로 붙어 있는 행사 표기를 그대로 옮깁니다(무료급식 행사 · 초복 등).
  -- 비어 있으면 평소 식단입니다.
  event_label text not null default '',
  -- 식단표에 「공휴일 휴관」처럼 적힌 날. holidays 표와 별개로, 식단표 기준의 미운영일입니다.
  closed boolean not null default false,
  -- 어느 게시물에서 옮겼는지. 나중에 값이 이상할 때 원본을 바로 찾아볼 수 있어야 합니다.
  source_url text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists menus_event_idx on menus (event_label) where event_label <> '';

alter table menus enable row level security;

-- 개인정보는 아니지만 다른 표와 권한 모양을 맞춥니다. 정책 모양이 표마다 다르면 나중에
-- 무엇이 열려 있는지 파악하기 어려워집니다.
--
-- (select ...) 로 감싼 이유: RLS 정책은 행마다 평가되므로, 함수를 그대로 쓰면 행 수만큼
-- 불립니다. 감싸면 쿼리 시작 시 한 번만 계산됩니다. migration_012 와 같은 이유입니다.
drop policy if exists "menus_read_approved" on menus;
create policy "menus_read_approved" on menus for select
  using ((select is_approved_user()));

drop policy if exists "menus_insert_approved" on menus;
create policy "menus_insert_approved" on menus for insert
  with check ((select is_approved_user()));

drop policy if exists "menus_update_approved" on menus;
create policy "menus_update_approved" on menus for update
  using ((select is_approved_user())) with check ((select is_approved_user()));

drop policy if exists "menus_delete_approved" on menus;
create policy "menus_delete_approved" on menus for delete
  using ((select is_approved_user()));

select 'menus 표 준비 완료' as 결과;
