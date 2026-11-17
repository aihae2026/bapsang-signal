// 「연락할 분」에 언제 뜨고 언제 빠지는가 — 날짜를 하루씩 넘기는 시뮬레이션
//
// 이 파일이 있는 이유는 실제로 현장에서 나온 물음 때문입니다 —
//
//   "이분은 부재중도 아닌데 왜 계속 연락할 분에 남아 있냐"
//   "25일부터 다시 뜨게 해야지, 왜 지금 떠 있냐"
//
// 한 어르신은 하루에 **정확히 한 상자**에만 있어야 합니다. 두 곳에 다 있으면
// 화면이 앞뒤로 다른 말을 하고, 어느 곳에도 없으면 그분이 조용히 사라집니다.
// 후자가 97세 독거 어르신 사고의 모양입니다.
//
// 아래는 그 규칙(isRestingOn)을 하루씩 돌려 보는 시험입니다. 규칙을 손볼 때
// 여기가 먼저 깨집니다.
//
// 실행: bun test

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_RECHECK_NEEDED,
  DEFAULT_RECHECK_NOT_NEEDED,
  isClosedFollowup,
  isRestingOn,
  recheckDueDate,
  suggestSnoozeDays,
  type Followup,
  type FollowupOutcome,
  type ResultKind,
} from "./attendance-engine";
import { classifyFollowupNote } from "./followup-classify";

const 기록 = (p: {
  checkedAt: string;
  outcome: FollowupOutcome;
  note?: string;
  snoozeUntil?: string | null;
  resultKind?: ResultKind | null;
}): Followup => ({
  id: `f-sim-${p.checkedAt}-${Math.random()}`,
  residentId: "2020-00001",
  checkedAt: p.checkedAt,
  staff: "시험",
  riskLevel: "crisis",
  outcome: p.outcome,
  note: p.note ?? "",
  snoozeUntil: p.snoozeUntil ?? null,
  resultKind: p.resultKind ?? null,
  resumeExpected: null,
  reaction: null,
  reactionNote: "",
  recordedAt: `${p.checkedAt}T09:00:00.000Z`,
});

/** YYYY-MM-DD 에 n 일을 더합니다. */
const 더하기 = (ds: string, n: number) => {
  const [y, m, d] = ds.split("-").map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

/** 기록한 날부터 하루씩 넘기며 「어느 상자에 있나」를 적습니다. */
const 달력 = (f: Followup, 날수: number) =>
  Array.from({ length: 날수 }, (_, i) => {
    const 오늘 = 더하기(f.checkedAt, i);
    return { 날: 오늘, 쉼: isRestingOn(f, 오늘) };
  });

/** 처음으로 「연락할 분」에 돌아오는 날. 끝까지 안 돌아오면 null. */
const 복귀일 = (f: Followup, 날수 = 400) => 달력(f, 날수).find((d) => !d.쉼)?.날 ?? null;

describe("기한을 안 걸었을 때 — 기본 기한이 붙습니다", () => {
  it("「도움이 더 필요」는 7일 쉬고 8일째 돌아옵니다", () => {
    const f = 기록({ checkedAt: "2026-09-18", outcome: "needed" });
    expect(recheckDueDate(f)).toBe("2026-09-25"); // 쉬는 마지막 날
    expect(복귀일(f)).toBe(더하기("2026-09-18", DEFAULT_RECHECK_NEEDED + 1));
    expect(복귀일(f)).toBe("2026-09-26");
  });

  it("「지금은 괜찮으심」은 14일 쉽니다", () => {
    const f = 기록({ checkedAt: "2026-09-18", outcome: "not_needed" });
    expect(복귀일(f)).toBe(더하기("2026-09-18", DEFAULT_RECHECK_NOT_NEEDED + 1));
  });
});

describe("기한을 직접 걸었을 때 — 그 날까지 쉬고 다음 날 돌아옵니다", () => {
  it("「~09-25까지」면 25일에는 아직 쉬고 26일에 돌아옵니다", () => {
    const f = 기록({ checkedAt: "2026-09-18", outcome: "not_needed", snoozeUntil: "2026-09-25" });
    expect(isRestingOn(f, "2026-09-25")).toBe(true);
    expect(isRestingOn(f, "2026-09-26")).toBe(false);
  });

  it("석 달 뒤로 미루면 그 사이 어느 날에도 안 뜹니다", () => {
    const f = 기록({ checkedAt: "2026-09-18", outcome: "not_needed", snoozeUntil: "2026-12-18" });
    for (const d of 달력(f, 91)) expect(d.쉼).toBe(true);
    expect(복귀일(f)).toBe("2026-12-19");
  });
});

describe("연락이 닿지 않은 분은 하루도 쉬지 않습니다", () => {
  // 사양: 「연락 불가는 해제 사유가 아니라 그 자체로 신호」.
  it("부재중은 기록한 그 날부터 목록에 있습니다", () => {
    const f = 기록({ checkedAt: "2026-09-18", outcome: "no_answer" });
    for (const d of 달력(f, 30)) expect(d.쉼).toBe(false);
  });

  it("갈래가 「확인불가」면 기한이 적혀 있어도 쉬지 않습니다", () => {
    // 기록을 나중에 고치면서 기한이 붙는 경로가 있었습니다. 그때도 막혀야 합니다.
    const f = 기록({
      checkedAt: "2026-09-18",
      outcome: "not_needed",
      snoozeUntil: "2026-11-18",
      resultKind: "확인불가",
    });
    expect(isRestingOn(f, "2026-09-19")).toBe(false);
  });
});

describe("종결하신 분은 돌아오지 않습니다", () => {
  const 종결갈래: ResultKind[] = ["사망", "요양원입소", "이사전출", "급식자격상실", "타기관이용"];
  for (const kind of 종결갈래) {
    it(`${kind} — 1년을 넘겨도 목록에 안 뜹니다`, () => {
      const f = 기록({ checkedAt: "2026-09-18", outcome: "not_needed", resultKind: kind });
      expect(isClosedFollowup(f)).toBe(true);
      expect(복귀일(f)).toBe(null);
    });
  }

  it("「사례 관리 종료」 단추(갈래 없이 [종결] 글머리)도 같습니다", () => {
    const f = 기록({ checkedAt: "2026-09-18", outcome: "not_needed", note: "[종결] 이사 가심" });
    expect(복귀일(f)).toBe(null);
  });
});

describe("적으신 글 한 줄이 끝까지 흘러갑니다", () => {
  // 담당자가 하는 일은 글을 쓰는 것 하나입니다. 그 글이 갈래 → 기한 → 목록까지
  // 제대로 이어지는지, 실제 문장으로 처음부터 끝까지 돌려 봅니다.
  const 흐름 = (문장: string, 적은날 = "2026-09-18") => {
    const kind = classifyFollowupNote(문장, 적은날).resultKind;
    const days = suggestSnoozeDays(kind);
    const f = 기록({
      checkedAt: 적은날,
      outcome: kind === "확인불가" ? "no_answer" : kind === "위기" ? "needed" : "not_needed",
      note: 문장,
      resultKind: kind,
      snoozeUntil: days > 0 ? 더하기(적은날, days) : null,
    });
    return { kind, 복귀: 복귀일(f) };
  };

  it("「다음주부터 다시 나올 예정」 — 일시적 사정으로 2주 쉽니다", () => {
    const r = 흐름("몸이 좋지 않아서 못 나왔었음. 다음주부터 다시 나올 예정");
    expect(r.kind).toBe("일시적사정");
    expect(r.복귀).toBe("2026-10-03");
  });

  it("「배우자와 통화. 8월에 사망하심」 — 종결되어 돌아오지 않습니다", () => {
    const r = 흐름("없는 번호로 확인되어 비상 연락처 확인하여 배우자와 통화함. 8월에 사망하심.");
    expect(r.kind).toBe("사망");
    expect(r.복귀).toBe(null);
  });

  it("「이웃 말로는 돌아가셨다고 함」 — 확인불가라 목록에 그대로 남습니다", () => {
    const r = 흐름("전화 안 받으심. 이웃 말로는 돌아가셨다고 함.");
    expect(r.kind).toBe("확인불가");
    expect(r.복귀).toBe("2026-09-18"); // 기록한 그 날부터
  });

  it("「입원 중이심」 — 위기로 2주 쉬고 경과를 다시 봅니다", () => {
    const r = 흐름("따님과 통화. 낙상으로 입원 중이심.");
    expect(r.kind).toBe("위기");
    expect(r.복귀).toBe("2026-10-03");
  });

  it("「일자리 나가심」 — 한 달 쉽니다", () => {
    const r = 흐름("본인 통화. 노인일자리 나가셔서 점심때 못 오심.");
    expect(r.kind).toBe("일자리프로그램참여");
    expect(r.복귀).toBe("2026-10-19");
  });
});

describe("두 상자가 한 사람을 두고 다른 말을 하지 않습니다", () => {
  // 「연락할 분」 = !isRestingOn · 「사유를 확인한 분」 = isRestingOn && !종결.
  // 어느 날에도 둘 다 참이거나 둘 다 거짓이면 안 됩니다(종결은 세 번째 상자).
  const 표본: Followup[] = [
    기록({ checkedAt: "2026-09-18", outcome: "needed" }),
    기록({ checkedAt: "2026-09-18", outcome: "not_needed" }),
    기록({ checkedAt: "2026-09-18", outcome: "no_answer" }),
    기록({ checkedAt: "2026-09-18", outcome: "not_needed", snoozeUntil: "2026-10-31" }),
    기록({ checkedAt: "2026-09-18", outcome: "not_needed", resultKind: "일시적사정" }),
    기록({ checkedAt: "2026-09-18", outcome: "not_needed", resultKind: "사망" }),
    기록({ checkedAt: "2026-09-18", outcome: "not_needed", note: "[종결] 이사" }),
  ];
  it("100일을 하루씩 넘겨도 언제나 정확히 한 상자", () => {
    for (const f of 표본) {
      for (let i = 0; i < 100; i++) {
        const 오늘 = 더하기("2026-09-18", i);
        const 쉼 = isRestingOn(f, 오늘);
        const 연락할분 = !쉼;
        const 종결 = isClosedFollowup(f);
        const 사유확인 = 쉼 && !종결;
        expect([연락할분, 사유확인, 종결 && 쉼].filter(Boolean).length).toBe(1);
      }
    }
  });
});
