-- ════════════════════════════════════════════════════════════════════
-- migration_027 — 「어르신 반응」 옆에 한 줄 적는 칸을 답니다
-- ════════════════════════════════════════════════════════════════════
--
-- 왜 필요한가:
--
--   migration_026 으로 반가워하심/불편해하심 두 단추를 달았습니다. 그런데 단추만으로는
--   **무엇 때문에** 그러셨는지가 남지 않습니다. 현장에서 나오는 이야기는 이런 것들입니다 —
--
--     반가워하심  "전화 줘서 고맙다고, 다음 주엔 꼭 나오시겠다고 하심"
--     불편해하심  "감시받는 것 같다고 하심"   ← 이건 우리가 방식을 바꿔야 하는 신호입니다
--
--   둘 다 'negative' 와 'positive' 라는 한 글자로 뭉개면, 한 해 치를 모아도 비율만
--   남고 **왜 그런지는 영영 알 수 없습니다.** 숫자는 무엇이 일어났는지 말해주지만
--   무엇을 고쳐야 하는지는 말해주지 않습니다.
--
--   확인 기록 본문(note)과 따로 두는 이유: 본문은 「어르신이 어떤 상황이신가」를 적는
--   자리이고(입원·이사·일시적 사정), 이 칸은 「우리 연락이 그분께 어떻게 닿았나」를
--   적는 자리입니다. 한 칸에 섞으면 나중에 갈라낼 수 없습니다.
--
--   비워두는 것이 기본입니다. 필수로 만들면 아무거나 적어 두게 되고, 그러면
--   한 해 치를 모아도 아무 뜻이 없습니다.
--
-- 실행: Supabase 대시보드 → SQL Editor → 붙여넣고 Run
-- 여러 번 실행해도 안전합니다.

alter table public.followups
  add column if not exists reaction_note text;

comment on column public.followups.reaction_note is
  '어르신 반응을 한 줄로. 단추(reaction)가 "어느 쪽인가"라면 이 칸은 "왜 그러셨나"입니다. 비어 있어도 됩니다.';

-- 길이 제한. 여기는 한 줄 적는 칸이고, 긴 이야기는 확인 기록 본문(note)에 적습니다.
-- 화면에서도 200자로 막지만, 화면을 거치지 않고 부르는 경우까지 DB 에서 막아둡니다.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'followups_reaction_note_len'
  ) then
    alter table public.followups
      add constraint followups_reaction_note_len
      check (reaction_note is null or char_length(reaction_note) <= 200);
  end if;
end $$;


-- ── 확인 ───────────────────────────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'followups'
      and column_name = 'reaction_note')                     as "reaction_note 칸(1이어야 함)",
  (select count(*) from pg_constraint
    where conname = 'followups_reaction_note_len')           as "길이 제약(1이어야 함)",
  (select count(*) from public.followups)                    as "기존 확인 기록 수",
  (select count(*) from public.followups where reaction_note is not null)
                                                             as "반응 메모가 적힌 기록(처음엔 0)";
