-- 가입 신청(access_requests) · 건의·문의(suggestions) 두 표를 추가합니다.
-- Supabase SQL Editor에서 실행하세요. 여러 번 실행해도 안전합니다.
--
-- ⚠️ 이 두 표는 다른 표와 권한 방향이 반대입니다.
--
--   다른 표(residents·memos 등): 조회는 누구나 / 쓰기는 로그인한 직원만
--   이 두 표:                    쓰기는 누구나 / 조회는 로그인한 직원만
--
-- 왜 반대인가:
--   · 쓰기를 열어야 하는 이유 — 가입 신청과 건의는 "아직 계정이 없는 사람"이 남기는 글입니다.
--     로그인을 요구하면 애초에 신청을 할 수 없습니다.
--   · 조회를 닫아야 하는 이유 — 신청자 이메일과 건의 본문은 공개되면 안 되는 내용입니다.
--     다른 표처럼 select using (true)로 두면 누구나 신청자 명단을 내려받을 수 있습니다.

-- ── 가입 신청 ──────────────────────────────────────────────
-- 공개 가입은 Supabase에서 껐습니다(아무 이메일로 가입해 쓰기 권한을 얻는 것을 막기 위함).
-- 대신 신청을 여기 받아두고, 관리자가 확인한 뒤 Supabase에서 계정을 직접 발급합니다.
create table if not exists access_requests (
  id text primary key,
  email text not null,
  name text not null default '',
  note text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);
create index if not exists access_requests_status_idx on access_requests (status, created_at desc);

alter table access_requests enable row level security;

drop policy if exists "access_requests_insert_anon" on access_requests;
create policy "access_requests_insert_anon" on access_requests for insert with check (true);

drop policy if exists "access_requests_read_auth" on access_requests;
create policy "access_requests_read_auth" on access_requests for select
  using (auth.role() = 'authenticated');

drop policy if exists "access_requests_update_auth" on access_requests;
create policy "access_requests_update_auth" on access_requests for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "access_requests_delete_auth" on access_requests;
create policy "access_requests_delete_auth" on access_requests for delete
  using (auth.role() = 'authenticated');

-- ── 건의·문의 ──────────────────────────────────────────────
create table if not exists suggestions (
  id text primary key,
  author text not null default '',
  category text not null default '건의' check (category in ('건의', '질문', '오류 신고')),
  text text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  reply text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists suggestions_status_idx on suggestions (status, created_at desc);

alter table suggestions enable row level security;

drop policy if exists "suggestions_insert_anon" on suggestions;
create policy "suggestions_insert_anon" on suggestions for insert with check (true);

drop policy if exists "suggestions_read_auth" on suggestions;
create policy "suggestions_read_auth" on suggestions for select
  using (auth.role() = 'authenticated');

drop policy if exists "suggestions_update_auth" on suggestions;
create policy "suggestions_update_auth" on suggestions for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "suggestions_delete_auth" on suggestions;
create policy "suggestions_delete_auth" on suggestions for delete
  using (auth.role() = 'authenticated');
