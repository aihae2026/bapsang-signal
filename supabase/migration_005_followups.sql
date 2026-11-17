-- 대응 이력(followups)
-- AI가 위기·주의로 분류한 어르신을 담당자가 실제로 확인했는지, 확인해보니 정말 개입이
-- 필요했는지를 기록합니다. 이 기록이 쌓이면 "AI가 위기로 분류한 N명 중 실제 개입이 필요했던
-- 비율"을 실측할 수 있습니다 — 본선 평가의 '현장 변화' 지표로 쓸 근거 데이터입니다.

create table if not exists followups (
  id text primary key,
  resident_id text not null references residents (id) on delete cascade,
  checked_at date not null,
  staff text not null,
  -- 확인 당시 AI가 매긴 등급. 나중에 등급이 바뀌어도 그때의 판단을 남겨둬야 적중률 계산이 됩니다.
  risk_level text not null,
  -- needed: 확인해보니 실제로 개입이 필요했음 / not_needed: 확인했으나 개입은 불필요했음
  outcome text not null check (outcome in ('needed', 'not_needed')),
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists followups_resident_idx on followups (resident_id);
create index if not exists followups_checked_at_idx on followups (checked_at);

alter table followups enable row level security;

-- ⚠️ 이 파일을 **다시 실행하지 마십시오.** 아래 정책은 최초 설치용입니다.
--
--    `using (true)` 는 로그인 없이도 읽힌다는 뜻입니다. migration_012 가 이것을 승인된
--    직원만 읽도록 바꿔 두었는데, RLS 정책은 OR 로 합쳐지므로 이 파일을 나중에 다시
--    돌리면 그 잠금이 **무력화됩니다** — 어르신 상담 내용이 로그인 없이 읽힙니다.
--    anon 키는 설계상 브라우저에 공개되는 값이라(번들에 들어 있습니다) 아무나 부를 수
--    있습니다. 표를 만드는 부분만 여러 번 실행해도 안전하고, 정책은 그렇지 않습니다.
--
-- 다른 표와 같은 원칙: 조회는 누구나, 추가·수정·삭제는 로그인한 직원만
drop policy if exists "followups_read_anon" on followups;
create policy "followups_read_anon" on followups for select using (true);

drop policy if exists "followups_insert_auth" on followups;
create policy "followups_insert_auth" on followups for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "followups_update_auth" on followups;
create policy "followups_update_auth" on followups for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "followups_delete_auth" on followups;
create policy "followups_delete_auth" on followups for delete
  using (auth.role() = 'authenticated');
