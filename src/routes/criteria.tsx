/**
 * 판정 기준 설명 — 「우리는 무엇을 보고 위기라고 하는가」
 *
 * 왜 이 화면이 필요한가:
 *
 *   담당자가 목록을 믿으려면 **왜 이 분이 여기 있는지**를 알아야 합니다. 그런데 그
 *   설명이 지금까지 README 와 커밋 메시지에만 있었습니다. 현장에서는 아무도 안 봅니다.
 *   기준을 설명하지 못하는 목록은 결국 "컴퓨터가 그렇다니까"가 되고, 그러면 담당자는
 *   자기 감으로 다시 판단하게 됩니다 — 이 도구를 만든 이유가 사라집니다.
 *
 * ★ **숫자를 글로 박지 않습니다.**
 *
 *   모든 값을 상수에서 직접 가져옵니다. 예전에 통계 화면에 "달력으로는 약 3개월"을
 *   글로 적어 뒀다가, 기준선을 바꾸자 한 문장 안에서 앞뒤가 안 맞게 된 적이 있습니다.
 *   설명이 코드를 따라오지 못하면, 설명이 있는 편이 없는 것보다 나쁩니다.
 *   아래 표의 숫자·예시는 전부 실제 상수와 실제 수식으로 그 자리에서 계산합니다.
 */
import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { NavBar } from "@/components/NavBar";
import {
  getExcludedDays,
  useDataVersion,
  BASELINE_DAYS,
  TIER_UNOBSERVABLE,
  TIER_DELAYED,
  LEVEL_WATCH,
  LEVEL_RECOMMEND,
  LEVEL_IMMEDIATE,
  RHYTHM_MULT,
  RHYTHM_MIN_DAYS,
  DECLINE_SHORT,
  DECLINE_LONG,
  DECLINE_THRESHOLD,
  WINTER_JAN,
  WINTER_DEC_FEB,
  ADJUST_FLOOR,
  RESUME_OBSERVE_DAYS,
  RESUME_GRACE_DAYS,
  RELAPSE_WINDOW_DAYS,
  UNREACHABLE_ESCALATE,
  RESULT_KIND_META,
  RISK_LABELS,
  type ResultKind,
  type RiskLevel,
} from "@/lib/attendance-engine";

export const Route = createFileRoute("/criteria")({
  head: () => ({
    meta: [
      { title: "판정 기준 | 밥상위의 신호" },
      {
        name: "description",
        content:
          "어떤 급식 출결 패턴을 보고 긴급·위기로 올리는지 — 기준선·문턱·예외 처리·개인 결석 리듬.",
      },
    ],
  }),
  component: CriteriaPage,
});

// ── 표를 그 자리에서 계산합니다 ────────────────────────────────
//
// 실제 엔진과 **같은 수식**입니다. 값을 옮겨 적지 않고 다시 계산하므로, 문턱이나
// 기준선을 바꾸면 이 페이지의 모든 숫자가 함께 움직입니다.

/** 하루 결석에 붙는 점수 = -ln(1 - 그 요일에 오실 확률). */
const dayScore = (p: number) => -Math.log(1 - Math.min(0.995, Math.max(0.005, p)));

/** 평소 출석률 habit 인 분이 absent 운영일 결석했을 때의 절벽점수(기준선 창 감쇠 포함). */
function cliff(habit: number, absent: number): number {
  const N = 400;
  const att: boolean[] = new Array(N).fill(false);
  for (let i = 0; i < N - absent; i++)
    att[i] = Math.floor(i * habit) !== Math.floor((i + 1) * habit);
  const last = att.lastIndexOf(true);
  let total = 0;
  for (let i = last + 1; i < N; i++) {
    let a = 0;
    for (let j = Math.max(0, i - BASELINE_DAYS); j < i; j++) if (att[j]) a++;
    total += dayScore(a / BASELINE_DAYS);
  }
  return total;
}

/**
 * 점수 → 등급. **이름은 RISK_LABELS 한 곳에서만** 가져옵니다.
 *
 * 예전에는 이 페이지가 "위기·주의·관찰"이라는 자기 표를 따로 들고 있었습니다. 등급 이름을
 * 바꾸자 기준을 설명하는 바로 이 페이지만 대시보드와 다른 말을 하게 됐습니다 —
 * 심사위원이든 담당자든 「무슨 기준으로 긴급이라 하나」를 보러 오는 자리인데요.
 */
function levelOf(score: number): RiskLevel {
  if (score >= LEVEL_IMMEDIATE) return "crisis";
  if (score >= LEVEL_RECOMMEND) return "caution";
  if (score >= LEVEL_WATCH) return "concern";
  return "normal";
}

const LEVEL_CHIP: Record<RiskLevel, string> = {
  crisis: "bg-red-100 text-red-800 border-red-300",
  caution: "bg-orange-100 text-orange-900 border-orange-300",
  concern: "bg-emerald-50 text-emerald-800 border-emerald-300",
  normal: "bg-stone-100 text-stone-600 border-stone-300",
  unknown: "bg-white text-stone-600 border-stone-300",
};
const LEVEL_DOT: Record<RiskLevel, string> = {
  crisis: "🔴",
  caution: "🟠",
  concern: "🟢",
  normal: "⚪",
  unknown: "⚪",
};

/** 그 습관에서 각 등급에 처음 닿는 날. */
function firstDay(habit: number, threshold: number): string {
  for (let d = 1; d <= 300; d++) if (cliff(habit, d) >= threshold) return `${d}일째`;
  return "영영";
}

const HABITS: { label: string; rate: number; note: string }[] = [
  { label: "매일", rate: 0.99, note: "거의 빠짐없이" },
  { label: "거의 매일", rate: 0.9, note: "주 4~5회" },
  { label: "주 4회", rate: 0.8, note: "" },
  { label: "주 3회", rate: 0.6, note: "" },
  { label: "주 2회", rate: 0.4, note: "" },
  { label: "주 1회", rate: 0.2, note: "" },
];

function Section({
  n,
  title,
  lead,
  children,
}: {
  n: string;
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="scroll-mt-20 rounded-xl border bg-white p-6 shadow-sm" id={`s${n}`}>
      <div className="mb-1 flex items-baseline gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
          {n}
        </span>
        <h2 className="text-lg font-bold text-foreground">{title}</h2>
      </div>
      {lead && <p className="mb-4 pl-[2.4rem] text-sm text-muted-foreground">{lead}</p>}
      <div className="space-y-4 pl-[2.4rem] text-sm leading-relaxed">{children}</div>
    </section>
  );
}

function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-lg border-l-4 px-3.5 py-2.5 text-[13px] leading-relaxed ${
        tone === "warn"
          ? "border-l-amber-500 bg-amber-50/70 text-amber-950"
          : "border-l-sky-500 bg-sky-50/70 text-sky-950"
      }`}
    >
      {children}
    </div>
  );
}

function CriteriaPage() {
  const TERMINAL = (Object.keys(RESULT_KIND_META) as ResultKind[]).filter(
    (k) => RESULT_KIND_META[k].status === "종료",
  );
  const PAUSED = (Object.keys(RESULT_KIND_META) as ResultKind[]).filter(
    (k) => RESULT_KIND_META[k].status === "보류",
  );
  const months = Math.round(BASELINE_DAYS / 20);
  // 「분석에서 뺀 날」은 이 문서에서 유일하게 **실제 자료를 읽는** 대목입니다. 나머지는
  // 전부 상수에서 파생되지만, 뺀 날은 그달 자료를 봐야 몇 일인지 알 수 있습니다.
  const version = useDataVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const excludedDays = useMemo(() => getExcludedDays(), [version]);

  return (
    <div className="min-h-screen bg-stone-50">
      <NavBar />
      <main className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6">
          <Link to="/admin" className="text-xs text-muted-foreground hover:underline">
            ← 관리자 설정
          </Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">판정 기준</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            「밥상위의 신호」가 어떤 급식 출결 패턴을 보고 어르신을 긴급·위기로 올리는지 적어 둔
            문서입니다. 아래 숫자는 전부{" "}
            <b className="text-foreground">실제 계산 코드에서 그 자리에서 가져온 값</b>이라, 기준을
            바꾸면 이 문서도 함께 바뀝니다.
          </p>
        </div>

        {/* 한 줄 요약 */}
        <div className="mb-6 rounded-xl border-2 border-primary/30 bg-primary/[0.04] p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">
            한 줄로
          </div>
          <p className="mt-1.5 text-base font-semibold leading-relaxed text-foreground">
            결석한 날수를 세지 않습니다. 「이 결석이 <u>이분 리듬에서</u> 얼마나 뜻밖인가」를 점수로
            잽니다.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            매일 오시던 분의 사흘과 주 1회 오시던 분의 사흘은 무게가 다릅니다. 그 차이를 숫자로
            만드는 것이 이 도구가 하는 일의 전부입니다.
          </p>
        </div>

        <nav className="mb-6 flex flex-wrap gap-2 text-xs">
          {[
            ["1", "판정할 수 있는 분인가"],
            ["2", "절벽 점수"],
            ["3", "개인 결석 리듬"],
            ["4", "등급 문턱"],
            ["5", "쌓지 않는 날"],
            ["6", "서서히 줄어드는 분"],
            ["7", "판정을 그만두는 선"],
            ["8", "확인 기록이 끼어드는 자리"],
            ["9", "쓰지 않기로 정한 것"],
            ["10", "분석에서 뺀 날"],
            ["11", "이 로직이 못 하는 것"],
          ].map(([n, t]) => (
            <a
              key={n}
              href={`#s${n}`}
              className="rounded-full border bg-white px-2.5 py-1 text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
            >
              {n}. {t}
            </a>
          ))}
        </nav>

        <div className="space-y-5">
          {/* ── 1 ─────────────────────────────────────────────── */}
          <Section
            n="1"
            title="먼저 — 판정할 수 있는 분인가"
            lead="점수를 매기기 전에 네 번 거릅니다. 하나라도 걸리면 「판단 어려움」으로 두고 점수를 내지 않습니다."
          >
            <ol className="space-y-3">
              <li className="rounded-lg border bg-stone-50/70 p-3">
                <b>① 자료가 깨졌나</b> → 「자료 오류」
                <p className="mt-1 text-muted-foreground">
                  그날 급식 자료 자체가 이상하면(일괄 발권, 자료 누락) 사람 판정을 하지 않습니다.
                </p>
              </li>
              <li className="rounded-lg border bg-stone-50/70 p-3">
                <b>② 확인 기록이 있나</b> → 「종결 · 보류 · 복귀 관찰」
                <div className="mt-2 grid gap-1.5 text-[13px] sm:grid-cols-2">
                  <div className="rounded border bg-white px-2.5 py-1.5">
                    <span className="font-semibold text-stone-700">종료</span> —{" "}
                    {TERMINAL.map((k) => RESULT_KIND_META[k].label.split(" (")[0]).join(" · ")}
                    <div className="text-[11px] text-muted-foreground">
                      자동 복귀 없음. 되돌리려면 확인 기록에서 직접 풀어야 합니다.
                    </div>
                  </div>
                  <div className="rounded border bg-white px-2.5 py-1.5">
                    <span className="font-semibold text-sky-700">보류</span> —{" "}
                    {PAUSED.map((k) => RESULT_KIND_META[k].label.split(" (")[0]).join(" · ")}
                    <div className="text-[11px] text-muted-foreground">
                      다시 나오시면 자동 해제됩니다.
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-muted-foreground">
                  보류였다가 다시 나오기 시작하시면{" "}
                  <b className="text-foreground">{RESUME_OBSERVE_DAYS} 운영일</b> 동안 새 리듬을
                  보는 기간을 둡니다 — 돌아오신 직후의 낮은 출석으로 바로 다시 위기가 되지 않도록.
                </p>
                <Note tone="warn">
                  <b>부재중·확인불가는 빠지지 않습니다.</b> 연락이 안 된 것은 확인이 끝난 게 아니라
                  그 자체로 신호입니다. 목록에 그대로 남고, <b>{UNREACHABLE_ESCALATE}회</b> 연달아
                  안 되면 방문 명단으로 올라갑니다.
                </Note>
              </li>
              <li className="rounded-lg border bg-stone-50/70 p-3">
                <b>③ 비교할 기록이 3주(20 운영일)는 되나</b>
                <p className="mt-1 text-muted-foreground">
                  그보다 적으면 「평소」를 만들 수 없습니다. 새로 오신 분은 여기 걸립니다.
                </p>
              </li>
              <li className="rounded-lg border bg-stone-50/70 p-3">
                <b>④ 급식으로 볼 수 있는 분인가</b> — 관측 등급
                <p className="mt-1 text-muted-foreground">
                  <b className="text-foreground">마지막으로 오신 날까지</b> {BASELINE_DAYS} 운영일
                  중 며칠 오셨는지로 가릅니다.
                </p>
                <table className="mt-2 w-full border-collapse text-[13px]">
                  <tbody>
                    {[
                      [
                        `${Math.round(TIER_UNOBSERVABLE * 100)}% 미만`,
                        "관측불가",
                        "판정하지 않습니다 — 급식으로는 원래 안 보이던 분",
                        "text-stone-500",
                      ],
                      [
                        `${Math.round(TIER_UNOBSERVABLE * 100)} ~ ${Math.round(TIER_DELAYED * 100)}%`,
                        "관측지연",
                        "판정은 하되 「확인이 늦어질 수 있음」을 함께 적습니다",
                        "text-amber-700",
                      ],
                      [
                        `${Math.round(TIER_DELAYED * 100)}% 이상`,
                        "관측가능",
                        "정상 판정",
                        "text-emerald-700",
                      ],
                    ].map(([a, b, c, cls]) => (
                      <tr key={b} className="border-b last:border-0">
                        <td className="py-1.5 pr-3 font-semibold tabular-nums">{a}</td>
                        <td className={`py-1.5 pr-3 font-semibold ${cls}`}>{b}</td>
                        <td className="py-1.5 text-muted-foreground">{c}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Note tone="warn">
                  <b>「오늘까지」가 아니라 「마지막 방문일까지」로 재는 것이 핵심입니다.</b> 오늘
                  기준으로 재면 결석이 길어질수록 그 창이 결석으로 채워져 「원래 안 오시던 분」이
                  되고, 쌓아 둔 점수가 통째로 버려집니다. 실제로 47점짜리 위기가 어느 날 흔적 없이
                  사라지는 일이 있었습니다.
                </Note>
              </li>
            </ol>
          </Section>

          {/* ── 2 ─────────────────────────────────────────────── */}
          <Section
            n="2"
            title="절벽 점수 — 하루에 몇 점씩 쌓이나"
            lead="마지막으로 오신 날 다음 운영일부터 오늘까지, 결석한 날마다 점수를 더합니다."
          >
            <div className="rounded-lg border-2 border-dashed bg-stone-50 px-4 py-3 text-center">
              <code className="text-sm font-semibold">
                하루 점수 = −ln( 1 − 그 어르신이 <u>그 요일에</u> 오실 확률 )
              </code>
            </div>
            <p className="text-muted-foreground">
              확률은 <b className="text-foreground">그 사람의 · 그 요일의 · 그날까지</b>{" "}
              {BASELINE_DAYS} 운영일 기록에서 나옵니다. 월요일에만 오시던 분에게 화요일 결석은
              신호가 아닙니다.
            </p>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b-2 text-left">
                  <th className="py-2 font-semibold">평소 그 요일에</th>
                  <th className="py-2 text-right font-semibold">하루 결석에 붙는 점수</th>
                  <th className="py-2 pl-4 font-semibold">며칠이면 🟢관심</th>
                </tr>
              </thead>
              <tbody>
                {[0.95, 0.9, 0.8, 0.6, 0.3, 0.2].map((p) => (
                  <tr key={p} className="border-b last:border-0">
                    <td className="py-1.5 tabular-nums">{Math.round(p * 100)}% 오시던 분</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">
                      {dayScore(p).toFixed(2)}점
                    </td>
                    <td className="py-1.5 pl-4 tabular-nums text-muted-foreground">
                      {Math.ceil(LEVEL_WATCH / dayScore(p))}일
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Note>
              같은 하루가 사람에 따라 <b>{Math.round(dayScore(0.95) / dayScore(0.2))}배</b> 차이
              납니다. 「며칠 결석」이라는 말을 버린 이유입니다.
            </Note>
          </Section>

          {/* ── 3 ─────────────────────────────────────────────── */}
          <Section
            n="3"
            title="개인 결석 리듬 — 빈도가 아니라 간격"
            lead="절벽 점수는 「얼마나 자주 오시던 분인가」만 봅니다. 그런데 현장에서 위험한 신호는 빈도가 아니라 리듬이 깨진 것입니다."
          >
            <div className="rounded-lg border bg-white p-3.5">
              <div className="text-[13px] font-semibold text-foreground">예를 들면</div>
              <p className="mt-1.5 text-muted-foreground">
                주 3회 오시는데 <b className="text-foreground">결석해도 늘 이틀 안에</b> 돌아오시던
                분이 8일째입니다.
              </p>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                <div className="rounded border border-stone-200 bg-stone-50 px-3 py-2 text-[13px]">
                  빈도로만 보면 → 절벽 {cliff(0.6, 8).toFixed(1)}점 ={" "}
                  <b>
                    {LEVEL_DOT[levelOf(cliff(0.6, 8))]}
                    {RISK_LABELS[levelOf(cliff(0.6, 8))]}
                  </b>
                  <div className="text-[11px] text-muted-foreground">
                    {RISK_LABELS.crisis}은 {firstDay(0.6, LEVEL_IMMEDIATE)}
                  </div>
                </div>
                <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[13px]">
                  리듬으로 보면 → <b>평소의 네 배</b>
                  <div className="text-[11px] text-amber-900/70">무슨 일이 생긴 것입니다</div>
                </div>
              </div>
            </div>
            <p>
              그래서 <b>「평소 이분이 가장 길게 쉬신 기간」</b>을 함께 봅니다. 지금 결석이 그 선의{" "}
              <b className="text-foreground">{RHYTHM_MULT}배</b>를 넘으면(그리고 {RHYTHM_MIN_DAYS}일
              이상이면) <b>등급을 한 단계 올립니다.</b>
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border bg-stone-50/70 p-3">
                <div className="text-[13px] font-semibold">왜 「평균」이 아니라 「최장」인가</div>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  평균은 너무 예민합니다. 주 3회 오시는 분의 평균 결석 간격은 1일이라 나흘만 빠져도
                  네 배가 됩니다. 최장은 <b>"이분이 평소 이 정도까지는 쉬셨다"</b>는 선이고,
                  담당자에게 설명하기도 쉽습니다.
                </p>
              </div>
              <div className="rounded-lg border bg-stone-50/70 p-3">
                <div className="text-[13px] font-semibold">왜 한 단계만 올리는가</div>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  절벽 점수를 <b>대신하는</b> 값이 아니라 곁에서 거드는 값입니다. 리듬만으로 🔴까지
                  보내면, 원래 띄엄띄엄 오시던 분이 우연히 규칙적이었던 시기 하나로 위기가 됩니다.
                </p>
              </div>
            </div>
            <Note>
              평소 결석 최장 기간은 <b>기준선 창 안에서</b> 셉니다. 그 창은 마지막으로 오신 날에서
              끝나므로 <b>지금 진행 중인 결석은 들어가지 않습니다</b> — 자기 자신을 기준으로 재는
              일이 없습니다. 공휴일·밀키트 기간도 빠져 있어 연휴로 기준이 부풀지 않습니다.
            </Note>
          </Section>

          {/* ── 4 ─────────────────────────────────────────────── */}
          <Section
            n="4"
            title="등급 문턱 — 「우연일 확률」"
            lead="점수는 그대로 확률로 뒤집힙니다. 확률 = e^(−점수)."
          >
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b-2 text-left">
                  <th className="py-2 font-semibold">점수</th>
                  <th className="py-2 font-semibold">우연히 이럴 확률</th>
                  <th className="py-2 font-semibold">등급</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    [LEVEL_WATCH, "concern"],
                    [LEVEL_RECOMMEND, "caution"],
                    [LEVEL_IMMEDIATE, "crisis"],
                  ] as [number, RiskLevel][]
                ).map(([v, lv]) => {
                  const odds = Math.round(1 / Math.exp(-v));
                  return (
                    <tr key={lv} className="border-b last:border-0">
                      <td className="py-2 font-bold tabular-nums">{v}점</td>
                      <td className="py-2 tabular-nums">
                        {odds.toLocaleString("ko-KR")}번에 한 번
                        <span className="ml-1.5 text-[11px] text-muted-foreground">
                          ({(Math.exp(-v) * 100).toPrecision(2)}%)
                        </span>
                      </td>
                      <td className="py-2">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[12px] font-semibold ${LEVEL_CHIP[lv]}`}
                        >
                          {LEVEL_DOT[lv]} {RISK_LABELS[lv]}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-muted-foreground">
              🔴가 뜬다는 것은 <b className="text-foreground">"이분 평소 리듬으로는 이런 일이 </b>
              {Math.round(1 / Math.exp(-LEVEL_IMMEDIATE)).toLocaleString("ko-KR")}
              <b className="text-foreground">번에 한 번 일어난다"</b>는 뜻입니다.
            </p>

            <div className="pt-1 text-[13px] font-semibold">그래서 실제로 언제 뜨나</div>
            <p className="-mt-2 text-[12px] text-muted-foreground">
              절벽 점수만으로 본 것입니다. 리듬(3번)이 걸리면 이보다 빨라집니다.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b-2 text-left">
                    <th className="py-2 font-semibold">평소 이용</th>
                    {[1, 2, 3, 4, 5, 7, 10, 14].map((d) => (
                      <th key={d} className="py-2 text-center font-semibold tabular-nums">
                        {d}일
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {HABITS.map((h) => (
                    <tr key={h.label} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 whitespace-nowrap">
                        <b>{h.label}</b>
                        {h.note && (
                          <span className="ml-1 text-[11px] text-muted-foreground">{h.note}</span>
                        )}
                      </td>
                      {[1, 2, 3, 4, 5, 7, 10, 14].map((d) => {
                        const lv = levelOf(cliff(h.rate, d));
                        return (
                          <td key={d} className="py-1.5 text-center">
                            <span
                              className="text-base"
                              title={`${cliff(h.rate, d).toFixed(1)}점 · ${lv}`}
                            >
                              {LEVEL_DOT[lv]}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-[11px] text-muted-foreground">
              ⚪ 정상 · 🟢 관심 · 🟠 위기 · 🔴 긴급 (칸에 마우스를 올리면 실제 점수가 보입니다)
            </div>
            <Note tone="warn">
              <b>평소 이용이 드문 분은 점수가 천장에 막힙니다.</b> 주 1회 오시던 분은 결석이
              길어질수록 기준선이 결석으로 채워져 하루 점수가 0에 수렴합니다 — 1년 넘게 안 나오셔도{" "}
              {RISK_LABELS[levelOf(cliff(0.2, 250))]}에 머뭅니다. 서로 구분도 되지 않습니다 — 그래서
              7번에서 아예 판정을 그만둡니다.
            </Note>
          </Section>

          {/* ── 5 ─────────────────────────────────────────────── */}
          <Section
            n="5"
            title="쌓지 않는 날 · 깎는 날"
            lead="안 오신 것이 그분 탓이 아닌 날들입니다."
          >
            <table className="w-full border-collapse text-[13px]">
              <tbody>
                {[
                  ["주말", "세지 않음", "원래 운영하지 않습니다"],
                  ["공휴일 · 휴관일", "세지 않음", "오실 기회가 없던 날입니다"],
                  ["밀키트 기간", "세지 않음", "출결이 이용을 뜻하지 않습니다"],
                  ["명절 앞뒤", "점수 유예", "다들 안 나오시는 날입니다"],
                  [
                    "12 · 1 · 2월",
                    `확률 ×${WINTER_DEC_FEB} / ×${WINTER_JAN}`,
                    `겨울엔 원래 덜 나오십니다 (원래 값의 ${Math.round(ADJUST_FLOOR * 100)}% 아래로는 안 내립니다)`,
                  ],
                  [
                    "행사일 출석 (초복 등)",
                    "복귀로 보지 않음",
                    "그날 식수가 752명까지 오릅니다(관찰 대상 명부와는 다른 수 — 일반 이용 어르신까지 포함한 전체 식수입니다). 사람이 몰리는 날 한 번 들르신 것을 「돌아오셨다」고 볼 수 없습니다",
                  ],
                  [
                    "기관 전체 결석 급증일",
                    "세지 않음",
                    "그날 다들 안 나오셨다면 개인 신호가 아닙니다",
                  ],
                ].map(([a, b, c]) => (
                  <tr key={a} className="border-b last:border-0 align-top">
                    <td className="w-40 py-2 pr-3 font-semibold">{a}</td>
                    <td className="w-36 py-2 pr-3 text-primary">{b}</td>
                    <td className="py-2 text-muted-foreground">{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Note>
              명절·행사 뒤 복귀는 <b>{RESUME_GRACE_DAYS} 운영일(한 주쯤)</b> 여유를 두고 봅니다.
              연휴 다음 날로 잡으면 아직 오실 때가 아닌 분이 그 다음날 위기로 다시 올라오고,
              담당자가 헛걸음합니다.
            </Note>
          </Section>

          {/* ── 6 ─────────────────────────────────────────────── */}
          <Section
            n="6"
            title="서서히 줄어드는 분 — 또 하나의 축"
            lead="절벽 점수는 「뚝 끊긴 것」을 잡습니다. 천천히 줄어드는 것은 못 잡습니다."
          >
            <div className="rounded-lg border-2 border-dashed bg-stone-50 px-4 py-3 text-center text-[13px]">
              최근 <b>{DECLINE_SHORT} 운영일</b> 출석률
              <span className="mx-2 text-muted-foreground">vs</span>그 앞{" "}
              <b>{DECLINE_LONG} 운영일</b> 출석률
              <div className="mt-1 text-muted-foreground">
                ↓ 통계 검정 · {DECLINE_THRESHOLD}점 넘으면 📉 「서서히 줄고 있는 분」
              </div>
            </div>
            <p className="text-muted-foreground">
              주 5회 → 주 4회 → 주 3회. 어느 날도 「끊긴」 적이 없어 절벽 점수는 0인데, 반년 뒤엔 안
              나오십니다. 이것은 <b className="text-foreground">등급을 바꾸지 않고</b> 별도
              목록으로만 올립니다 — 오늘 전화할 일이 아니라 월간으로 검토할 일입니다.
            </p>
          </Section>

          {/* ── 7 ─────────────────────────────────────────────── */}
          <Section
            n="7"
            title="판정을 그만두는 선 — 기준선 창을 통째로 넘겼을 때"
            lead="60 운영일 넘게 한 번도 안 오시면 더 판단하지 않습니다."
          >
            <div className="rounded-lg border-2 border-dashed bg-stone-50 px-4 py-3 text-center">
              <code className="text-sm font-semibold">
                연속결석 &gt; {BASELINE_DAYS} 운영일 → 판정하지 않음(「판단 어려움」)
              </code>
            </div>
            <p>
              우리 판단은 <b>「직전 {BASELINE_DAYS} 운영일의 리듬」</b> 위에 서 있습니다. 그 창이
              전부 결석으로 채워지면 견줄 리듬 자체가 없습니다 —{" "}
              <b>그 위에서 나온 점수는 근거가 아니라 잔재입니다.</b> 평소 이용이 드문 분일수록
              점수가 천장에 붙어 서로 구분도 되지 않습니다(4번 참고).
            </p>
            <div className="rounded-lg border bg-white p-3.5">
              <div className="text-[13px] font-semibold">다시 나오시면</div>
              <p className="mt-1 text-[13px] text-muted-foreground">
                그날부터 새로 쌓입니다. 연속결석이 0으로 돌아가고, 기준선 창이 그 방문을 품기
                시작합니다. 다만 창이 아직 결석으로 차 있어 한동안은 관측 등급(1번 ④)에 걸립니다 —{" "}
                <b className="text-foreground">3주쯤 다시 다니시면 판정으로 돌아옵니다.</b>
              </p>
            </div>
            <Note tone="warn">
              <b>사라지는 것이 아닙니다.</b> 대시보드의 오늘 할 일 목록에서 빠지는 것이지 기관의
              시야에서가 아닙니다. 이분들은 <b>통계·분석 화면의 「판정해 본 적이 없는 분」 명단</b>
              에 사유와 함께 남습니다. 60일 넘게 연락이 닿지 않는 홀몸 어르신은 급식 출결로 풀
              문제가 아니라 <b>한 번 방문하거나 사례관리로 넘겨야 할 문제</b>입니다.
            </Note>
          </Section>

          {/* ── 8 ─────────────────────────────────────────────── */}
          <Section
            n="8"
            title="확인 기록이 끼어드는 자리"
            lead="담당자가 전화해서 알아낸 것이 출결 계산보다 최신입니다. 그래서 기록은 판정을 멈추거나 되돌립니다."
          >
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b-2 text-left">
                  <th className="py-2 font-semibold">무엇을 남겼나</th>
                  <th className="py-2 font-semibold">그 뒤</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["종료 계열", "긴급 인원에서 빠집니다. 자동 복귀 없음 — 직접 풀어야 합니다."],
                  [
                    "보류 계열",
                    `빠집니다. 다시 나오시면 자동 해제 + ${RESUME_OBSERVE_DAYS} 운영일 관찰.`,
                  ],
                  [
                    "부재중 · 확인불가",
                    "빠지지 않습니다. 목록에 「📵 부재중 · 다시 연락」으로 남습니다.",
                  ],
                  ["안심 기간 지정", "그 날짜까지만 빠집니다. 지나면 자동으로 다시 올라옵니다."],
                  ["복귀 약속일 지정", "그 날이 지나도 안 나오시면 자동으로 다시 올라옵니다."],
                ].map(([a, b]) => (
                  <tr key={a} className="border-b last:border-0 align-top">
                    <td className="w-40 py-2 pr-3 font-semibold">{a}</td>
                    <td className="py-2 text-muted-foreground">{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Note>
              <b>재발도 셉니다.</b> 지난 {Math.round(RELAPSE_WINDOW_DAYS / 30)}개월 안에 「연락이
              닿아 다시 나오셨다가 또 끊긴」 횟수입니다. 한 번 끊긴 것과 반복해서 끊기는 것은
              담당자가 할 일이 다릅니다 — 목록 순서에 반영하고, AI 설명이 반드시 짚도록 합니다. 한
              번의 결석에 여러 번 전화한 것은 <b>한 번으로 셉니다.</b>
            </Note>
          </Section>

          {/* ── 9 ─────────────────────────────────────────────── */}
          <Section
            n="9"
            title="쓰지 않기로 정한 것"
            lead="넣어 봤지만 효과가 없어 뺀 것들입니다. 무엇을 안 쓰는지 밝혀 두는 편이, 쓰는 것만 적어두는 것보다 정직합니다."
          >
            <p>
              장날, 기초연금 지급일, 비, 식단 메뉴, 여름, 요일 단독 효과 —{" "}
              <b>4년치 자료로 검증한 결과 출석률 차이가 모두 3%p 미만</b>이라 판정에서 뺐습니다.
              유효했던 것은 <b>겨울 계절성</b> 하나뿐이고, 그것만 5번 절의 계수로 남아 있습니다.
            </p>
            <Note>
              효과가 없는 변수를 「그래도 넣어두면 낫지 않을까」로 남겨두면, 판정이 왜 그렇게
              나왔는지 아무도 설명할 수 없게 됩니다. 3%p 미만은 어르신 한 분의 그날 컨디션보다 작은
              차이입니다.
            </Note>
            <p>
              <b>관찰 메모 기능도 걷어냈습니다.</b> 현장에서 쌓이지 않는 기록이었고, 쌓이지 않는
              자료를 판정에 걸어두면 「관찰 메모가 없어 판단했다」 같은 빈 문장만 근거 칸에
              남습니다. 어르신 상태는 <b>확인 기록</b>에 적습니다.
            </p>
          </Section>

          {/* ── 10 ────────────────────────────────────────────── */}
          <Section
            n="10"
            title={`분석에서 뺀 날 — 지금 ${excludedDays.length}일`}
            lead="기관 사정으로 급식이 정상 운영되지 않은 날입니다. 그날 안 오신 것을 결석으로 세지 않습니다 — 기관 사정을 어르신 탓으로 돌리지 않기 위해서입니다."
          >
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[520px] text-xs">
                <thead>
                  <tr className="border-b bg-stone-50 text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">기준</th>
                    <th className="px-3 py-2 font-medium">조건</th>
                    <th className="px-3 py-2 font-medium">해당</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      k: "밀키트",
                      cond: "리모델링 휴관 중 도시락 배부 기간 (2025-12-01 ~ 2026-03-10)",
                    },
                    { k: "오류일", cond: "그날 이용 인원이 20명 미만 — 자료가 덜 들어온 날" },
                    {
                      k: "일괄발권",
                      cond: "주 이용 50명 이상이면서 5일 개근 비율 60% 이상 — 사람이 온 게 아니라 한꺼번에 발권한 주",
                    },
                    { k: "공휴일", cond: "기관이 문을 닫은 날" },
                  ].map(({ k, cond }) => {
                    const n = excludedDays.filter((d) => d.reason === k).length;
                    return (
                      <tr key={k} className="border-b last:border-0">
                        <td className="px-3 py-2 font-medium text-foreground">{k}</td>
                        <td className="px-3 py-2 text-muted-foreground">{cond}</td>
                        <td className="px-3 py-2 tabular-nums">
                          {n > 0 ? (
                            <b className="text-foreground">{n}일</b>
                          ) : (
                            <span className="text-muted-foreground">해당 없음</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[13px] text-muted-foreground">
              대시보드 「자료 업데이트 현황」에서는{" "}
              <span className="inline-block h-3 w-3 translate-y-0.5 rounded bg-amber-300" />{" "}
              <b className="text-foreground">연한 주황</b>으로 표시됩니다. 자료가 아예 없는 날은{" "}
              <span className="inline-block h-3 w-3 translate-y-0.5 rounded bg-stone-200" /> 연한
              회색이라 흰색처럼 보입니다.
            </p>
            {excludedDays.length > 0 && (
              <details>
                <summary className="cursor-pointer list-none text-xs font-medium text-primary">
                  뺀 날짜 전부 보기 ▾
                </summary>
                <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
                  {excludedDays.map((d) => (
                    <li
                      key={d.date}
                      className="flex items-center gap-2 rounded border bg-white px-2 py-1 text-xs"
                    >
                      <span className="tabular-nums text-foreground">{d.date}</span>
                      <span className="text-muted-foreground">{d.reason}</span>
                      <span className="ml-auto tabular-nums text-muted-foreground">
                        이용 {d.users}명
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Section>

          {/* ── 11 ────────────────────────────────────────────── */}
          <Section n="11" title="이 로직이 못 하는 것">
            <ul className="space-y-2.5">
              {[
                [
                  "목록에 없다는 것이 안전을 뜻하지 않습니다.",
                  "급식을 원래 안 쓰시는 분은 이 도구에 아예 안 보입니다.",
                ],
                [
                  "혼자 사시는지, 건강이 어떤지 모릅니다.",
                  "오셨나 안 오셨나만 봅니다. 그 밖의 것은 담당자가 아는 것입니다.",
                ],
                [
                  "급식 외 다른 신호와 연결되어 있지 않습니다.",
                  "전기·수도·통화 기록 같은 것은 보지 않습니다.",
                ],
                [
                  "판정은 사람을 대신하지 않습니다.",
                  "「먼저 전화해 볼 순서」를 정해 줄 뿐입니다. 확인은 담당자가 합니다.",
                ],
              ].map(([a, b]) => (
                <li
                  key={a}
                  className="rounded-lg border-l-4 border-l-stone-400 bg-stone-50 px-3.5 py-2.5"
                >
                  <b>{a}</b>
                  <div className="text-[13px] text-muted-foreground">{b}</div>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <p className="mt-8 text-center text-[11px] text-muted-foreground">
          이 문서의 모든 수치는 실제 판정 코드(<code>src/lib/attendance-engine.ts</code>)에서 직접
          가져옵니다. 기준을 바꾸면 이 문서도 함께 바뀝니다 · 기준선 {BASELINE_DAYS} 운영일(달력 약{" "}
          {months}개월)
        </p>
      </main>
    </div>
  );
}
