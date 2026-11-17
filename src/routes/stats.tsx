import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen, ChevronLeft, ChevronRight, Settings2, UtensilsCrossed } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NavBar } from "@/components/NavBar";
import { ResidentName, residentSubtitle } from "@/components/ResidentName";
import { ResidentAvatar } from "@/components/ResidentAvatar";
import { RiskBadge } from "@/components/RiskBadge";
import { useSession } from "@/lib/use-session";
import {
  DATA_END_STR,
  DATA_START_STR,
  OPERATING_DAYS,
  TODAY_DATE,
  formatDateWithWeekday,
  getActiveResidents,
  getAttendanceShifts,
  getCurrentRisk,
  getMonthDetectedIds,
  PRECISION_MIN_SAMPLE,
  getFollowupStats,
  getReactionStats,
  REACTION_MIN_SAMPLE,
  getFollowupStatsAll,
  getMonthlyStats,
  getPeriodStats,
  getUnanalyzable,
  getSpecialDayAbsences,
  getResidentById,
  residents,
  FOLLOWUPS,
  RISK_LABELS,
  useDataVersion,
  type Resident,
  type RiskLevel,
} from "@/lib/attendance-engine";

// 통계·분석 화면.
//
// 왜 나눴나: 대시보드는 "오늘 누구에게 연락하나"에 집중해야 하는데, 추이 그래프·행사일
// 분석·판단 어려움 명단·도움 필요 비율까지 한 화면에 있으면 정작 위기 명단을 놓칩니다. 그래서
// 매번 볼 필요는 없지만 월 단위로 확인해야 하는 자료를 이 화면으로 모았습니다.

export const Route = createFileRoute("/stats")({
  head: () => ({
    meta: [
      { title: "통계 · 분석 | 밥상위의 신호" },
      {
        name: "description",
        content:
          "월별 출석·위기 추이, 행사일 결석, 판단 어려움 명단, 도움 필요 비율을 보는 분석 화면.",
      },
    ],
  }),
  component: StatsPage,
});

interface ListEntry {
  resident: Resident;
  rightLabel: string;
  /** 등급 배지. 등급을 말할 근거가 없는 목록에서는 붙이지 않습니다. */
  badge?: RiskLevel;
}

function getTrendMonths(): { year: number; month: number; label: string }[] {
  const [startY, startM] = DATA_START_STR.split("-").map(Number);
  const [endY, endM] = DATA_END_STR.split("-").map(Number);
  const months: { year: number; month: number; label: string }[] = [];
  let y = startY;
  let m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    months.push({ year: y, month: m, label: `${y}.${m}` });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

function getMonthRiskEntries(
  year: number,
  month: number,
  level: "crisis" | "caution",
): ListEntry[] {
  const monthEnd = new Date(year, month, 0);
  return getActiveResidents()
    .map((r) => ({ resident: r, risk: getCurrentRisk(r, monthEnd) }))
    .filter((x) => x.risk.level === level)
    .sort((a, b) => a.risk.rate - b.risk.rate)
    .map(({ resident, risk }) => ({ resident, rightLabel: `${risk.rate}%`, badge: risk.level }));
}

function ListDialog({
  open,
  onOpenChange,
  title,
  entries,
  unit = "명",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  entries: ListEntry[];
  // 세는 단위. 대부분은 사람 수인데, 확인 기록 목록만은 **건수**입니다 —
  // 같은 어르신이 세 번 나올 수 있고, 그게 맞습니다.
  unit?: "명" | "건";
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {title} ({entries.length}
            {unit})
          </DialogTitle>
        </DialogHeader>
        <ul className="divide-y">
          {/* key 에 자리번호를 섞습니다. 건수 목록은 같은 어르신이 여러 번 나오는데,
              id 만 쓰면 React 가 같은 항목으로 보고 둘째부터 그리지 않습니다. */}
          {entries.map(({ resident: r, rightLabel, badge }, i) => (
            <li key={`${r.id}-${i}`} className="py-2.5">
              <Link
                to="/resident/$id"
                params={{ id: r.id }}
                className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1 hover:bg-stone-50"
              >
                <div className="flex items-center gap-2.5">
                  <ResidentAvatar seed={r.id} photoUrl={r.photoUrl} size={32} />
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      <ResidentName resident={r} />
                    </div>
                    <div className="text-xs text-muted-foreground">{residentSubtitle(r)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {badge && <RiskBadge level={badge} />}
                  <span className="text-xs text-muted-foreground">{rightLabel}</span>
                </div>
              </Link>
            </li>
          ))}
          {entries.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">해당하는 어르신이 없습니다.</p>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

const ATTENDANCE_TREND_MIN = 20;

function StatsPage() {
  const version = useDataVersion();
  const session = useSession();
  const [listDialog, setListDialog] = useState<{
    title: string;
    entries: ListEntry[];
    unit?: "명" | "건";
  } | null>(null);

  const thisMonthKey = `${TODAY_DATE.getFullYear()}-${String(TODAY_DATE.getMonth() + 1).padStart(2, "0")}`;
  // 「조회 월」 고르는 자리를 없앴습니다.
  //
  //   화면 맨 위에 있으니 페이지 전체가 그 달로 바뀐다고 읽히는데, 실제로 움직이는 것은
  //   행사일 카드와 「이번 N월 확인 건수」 한 줄뿐이었습니다. 그래프 넉 장은 자기 화살표를
  //   따로 가지고 있고요. 아무 일도 안 일어나는 것처럼 보이는 조작 장치는 없느니만
  //   못합니다 — 담당자가 "이 화면은 내 말을 안 듣는다"고 배우게 됩니다.
  //
  //   그래서 이 둘은 **언제나 이번 달**을 봅니다. 지난달 행사일을 봐야 할 일이 생기면
  //   그때 그 카드 안에 화살표를 답니다(그래프처럼 자기 자리에서).
  const [calYear, calMonth] = thisMonthKey.split("-").map(Number);

  const activeResidents = useMemo(() => getActiveResidents(), [version]);
  // 분석에서 뺀 날과 이유 — 대시보드는 깔끔하게 두고 근거는 여기서 보여줍니다.
  // 판정해 본 적이 없는 분 — 자료가 깨졌거나 기록이 아직 3주에 못 미치는 분.
  const unanalyzable = useMemo(() => getUnanalyzable(), [version]);

  // ── 추이 데이터 ─────────────────────────────────────────────
  //
  // 넉 장의 그래프에 스무 달을 한 줄로 밀어 넣으니 가로 눈금이 두 달에 하나씩만 찍히고,
  // 막대는 손가락보다 얇아져 어느 달인지 짚을 수 없었습니다. 여섯 달씩 끊어 보여주고
  // 화살표로 앞뒤 창을 옮깁니다. 넉 장이 **같은 창**을 봅니다 — 따로 놀면 "9월 위기가
  // 늘었는데 출석은 그대로네" 같은 비교가 어긋납니다.
  //
  // 덤으로 빨라집니다. 위기·주의 그래프는 어르신 403분 × 달 수만큼 판정을 다시 돌리는데,
  // 스무 달이 여섯 달이 되면 그 일이 3분의 1 이하로 줄어듭니다.
  const allTrendMonths = getTrendMonths();
  /** 한 화면에 보여줄 달 수. */
  const TREND_WINDOW = 6;
  /** 0 = 가장 최근 여섯 달. 1 = 그 앞 여섯 달. 숫자가 클수록 과거입니다. */
  const [trendOffset, setTrendOffset] = useState(0);
  const trendEnd = Math.max(TREND_WINDOW, allTrendMonths.length - trendOffset * TREND_WINDOW);
  const trendMonths = allTrendMonths.slice(Math.max(0, trendEnd - TREND_WINDOW), trendEnd);
  const trendRangeLabel =
    trendMonths.length > 0
      ? `${trendMonths[0].label} ~ ${trendMonths[trendMonths.length - 1].label}`
      : "";
  /** 더 과거로 갈 수 있나 (화살표를 끌 때 씁니다). */
  const canTrendOlder = trendEnd - TREND_WINDOW > 0;
  const canTrendNewer = trendOffset > 0;
  // 문 닫은 달은 **0이 아니라 빈칸**입니다.
  //
  // 리모델링·밀키트 대체급식 기간이 "평균 출석 0명"으로 찍히니, 선이 바닥까지 떨어져
  // 이용이 급감한 것처럼 보였습니다. 0명은 "아무도 안 왔다"는 뜻인데 실제로는 "그날
  // 급식이 없었다"입니다. 둘은 전혀 다른 이야기라 같은 점으로 그리면 안 됩니다.
  // 선을 끊고(null), 아래에 그 달이 어떤 기간이었는지 적습니다.
  const attendanceTrendData = trendMonths.map(({ year, month, label }) => {
    const avg = getPeriodStats({ kind: "month", year, month }).avgAttendance;
    return { year, month, label, 출석인원: avg > 0 ? avg : null, 휴관: avg === 0 };
  });
  const closedMonths = attendanceTrendData.filter((d) => d.휴관).map((d) => d.label);
  const attendanceTrendMax = Math.max(
    ATTENDANCE_TREND_MIN + 10,
    ...attendanceTrendData.map((d) => d.출석인원 ?? 0),
  );
  const attendanceTrendTickMax = Math.ceil(attendanceTrendMax / 5) * 5;
  const attendanceTrendTicks = Array.from(
    { length: (attendanceTrendTickMax - ATTENDANCE_TREND_MIN) / 5 + 1 },
    (_, i) => ATTENDANCE_TREND_MIN + i * 5,
  );
  const riskTrendData = useMemo(
    () =>
      trendMonths.map(({ year, month, label }) => {
        // ★ 대시보드 카드·위험군 리포트와 **같은 함수**로 셉니다.
        //   예전에는 여기만 그 달 말 기준 등급으로 세서, 확인을 마쳐 판정이 멈춘 분이
        //   막대에서만 빠졌습니다 — 「9월 긴급」이 대시보드 11명 · 막대 4명이었고,
        //   그 막대를 누르면 열리는 명단은 또 다른 수였습니다.
        // ★ 조회 달이 **자료의 마지막 달**이면 그 달 이후에 적은 기록도 함께 셉니다.
        //   자료 기준일이 달을 넘기면 오늘 전화하고 적은 기록의 날짜가 다음 달이 됩니다.
        //   달 접두어로만 거르면 그 기록이 어디에도 안 잡혀 **확인할수록 그 달 인원이
        //   줄어듭니다.** 대시보드는 이미 같은 방식으로 셉니다.
        const after =
          `${year}-${String(month).padStart(2, "0")}` === DATA_END_STR.slice(0, 7)
            ? DATA_END_STR
            : undefined;
        const crisis = getMonthDetectedIds(year, month, "crisis", after).size;
        const caution = getMonthDetectedIds(year, month, "caution", after).size;
        return { label, year, month, 긴급: crisis, 위기: caution };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, activeResidents],
  );

  // 월별 「자료에서 처음 확인된 어르신」.
  //
  // 예전 이름은 「신규 등록」이었습니다. 그런데 이 값이 세는 것은 registeredAt —
  // **급식 자료에서 그분이 처음 보인 날**입니다. 4년치를 처음 불러온 달에는 오래 다니신
  // 분들까지 전부 이 달에 "새로 등록"한 것처럼 잡힙니다. 세는 것과 이름이 다르면
  // 담당자는 없는 증가를 보고합니다.
  // "이번 달에 몇 분이 새로 오시기 시작했나"를 보는 지표입니다.
  const newResidentTrend = useMemo(
    () =>
      trendMonths.map(({ year, month, label }) => {
        const prefix = `${year}-${String(month).padStart(2, "0")}`;
        const n = residents.filter((r) => (r.registeredAt ?? "").startsWith(prefix)).length;
        return { label, year, month, 처음확인: n };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  // 월별 개입 활동 — 확인 기록이 얼마나 쌓였고, 그중 실제 개입이 필요했던 비율은 얼마인지.
  // 이 도구가 현장을 실제로 움직였는지 보여주는 지표입니다.
  const followupTrend = useMemo(
    () =>
      trendMonths.map(({ year, month, label }) => {
        const st = getFollowupStats(year, month);
        return {
          label,
          year,
          month,
          확인완료: st.checked,
          개입필요: st.needed,
          "도움 필요 비율": st.precision ?? 0,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const openMonthRiskList = (year: number, month: number, level: "crisis" | "caution") =>
    setListDialog({
      title: `${year}년 ${month}월 ${RISK_LABELS[level]} 인원`,
      entries: getMonthRiskEntries(year, month, level),
    });

  // 막대 클릭 → 그 달에 자료에서 처음 보인 분 명단
  const openNewResidentList = (year: number, month: number) => {
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    const monthEnd = new Date(year, month, 0);
    const rows = residents
      .filter((r) => (r.registeredAt ?? "").startsWith(prefix))
      .sort((a, b) => (a.registeredAt ?? "").localeCompare(b.registeredAt ?? ""))
      .map((resident) => ({
        resident,
        rightLabel: `첫 이용 ${(resident.registeredAt ?? "").slice(5)}`,
        badge: getCurrentRisk(resident, monthEnd).level,
      }));
    setListDialog({ title: `${year}년 ${month}월 자료에서 처음 확인된 어르신`, entries: rows });
  };

  // 개입 활동 막대 클릭 → 그 달의 확인 기록(누구를·어떤 결과로)
  const openFollowupList = (year: number, month: number) => {
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    const rows = FOLLOWUPS.filter((f) => f.checkedAt.startsWith(prefix))
      .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
      .map((f) => {
        const resident = getResidentById(f.residentId);
        const closed = f.note.startsWith("[종결]");
        const label = closed
          ? "종결"
          : f.outcome === "needed"
            ? "개입 필요"
            : f.outcome === "no_answer"
              ? "부재중"
              : "지금은 괜찮으심";
        return resident
          ? {
              resident,
              rightLabel: `${f.checkedAt.slice(5)} · ${label}${f.staff ? ` · ${f.staff}` : ""}`,
              badge: f.riskLevel,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    setListDialog({ title: `${year}년 ${month}월 개입 활동 기록`, entries: rows });
  };

  /**
   * 「대응 이력」의 숫자를 누르면 그 기록들이 누구의 것인지 보여줍니다.
   *
   * 숫자만 있으면 담당자가 확인할 방법이 없습니다 — 부재중 27건이 스물일곱 분인지
   * 세 분께 아홉 번씩인지가 안 보입니다. 그 둘은 오늘 할 일이 완전히 다릅니다.
   *
   * 여기는 **건수**입니다. 같은 어르신이 여러 줄 나오는 것이 맞습니다.
   */
  const openOutcomeList = (which: "all" | "needed" | "notNeeded" | "no_answer") => {
    const rows = FOLLOWUPS.filter((f) => {
      if (which === "all") return true;
      if (which === "needed") return f.outcome === "needed";
      if (which === "no_answer") return f.outcome === "no_answer";
      // 「지금은 괜찮으심」은 나머지 전부입니다(tallyFollowups 와 같은 셈).
      return f.outcome !== "needed" && f.outcome !== "no_answer";
    })
      .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
      .map((f) => {
        const resident = getResidentById(f.residentId);
        if (!resident) return null;
        const closed = f.note.startsWith("[종결]");
        const label = closed
          ? "종결"
          : f.outcome === "needed"
            ? "도움이 더 필요"
            : f.outcome === "no_answer"
              ? "부재중"
              : "지금은 괜찮으심";
        return {
          resident,
          rightLabel: `${f.checkedAt.slice(5)} · ${label}${f.staff ? ` · ${f.staff}` : ""}`,
          badge: f.riskLevel,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const title =
      which === "all"
        ? "확인 기록 전체"
        : which === "needed"
          ? "도움이 더 필요했던 기록"
          : which === "no_answer"
            ? "연락이 닿지 않은 기록"
            : "확인했고 지금은 괜찮으신 기록";
    setListDialog({ title, entries: rows, unit: "건" });
  };

  const openMonthAttendanceList = (year: number, month: number) => {
    // 그 달에 **오실 기회가 하루도 없던 분은 뺍니다.**
    //
    // 같은 화면의 평균(getPeriodStats)은 `total > 0` 으로 거르는데 이 명단만 안 걸러서,
    // 그 달에 아직 등록도 안 된 분이 「0회 / 0일 (0%)」로 줄줄이 섞여 나왔습니다.
    // 평균과 명단이 다른 모수를 쓰면 담당자가 숫자를 맞춰볼 수 없습니다.
    const roster = getActiveResidents()
      .map((r) => ({ resident: r, stats: getMonthlyStats(r, year, month) }))
      .filter((x) => x.stats.total > 0)
      .sort((a, b) => b.stats.present - a.stats.present);
    setListDialog({
      title: `${year}년 ${month}월 어르신별 출석 횟수`,
      entries: roster.map(({ resident, stats }) => ({
        resident,
        rightLabel: `${stats.present}회 / ${stats.total}일 (${stats.rate}%)`,
        // ★ 배지를 아예 붙이지 않습니다. 예전에는 상수 "normal" 을 넣어, 긴급
        //   어르신에게까지 초록 「정상」이 붙었습니다. 대시보드는 같은 목록에서
        //   일부러 배지를 뺐는데 여기만 「정상」이라고 단언하고 있었습니다.
      })),
    });
  };

  const shifts = getAttendanceShifts();
  const operatingDayCount = OPERATING_DAYS.length;
  const specialDays = getSpecialDayAbsences(calYear, calMonth);
  const crowdedDays = specialDays.filter((d) => d.drewCrowd);
  const quietEventDays = specialDays.filter((d) => !d.drewCrowd);
  // 도움 필요 비율은 **누적**으로 냅니다(표본이 적으면 비율이 우연히 흔들립니다).
  // 활동량(몇 건 확인했나)은 업무 리듬이라 이번 달 것을 따로 함께 보여줍니다.
  const followupStats = getFollowupStatsAll();
  const monthFollowupStats = getFollowupStats(calYear, calMonth);
  // 판단이 끝난 건수 = 개입 필요 + 지금은 괜찮으심 (부재중은 아직 확인 못 한 것이라 뺍니다)
  const decidedCount = followupStats.needed + followupStats.notNeeded;
  // 어르신 반응은 **연 단위**로 냅니다. 한 달 치는 스무 건 남짓이라 한두 분의 기분이
  // 비율을 흔듭니다. 이 숫자로 말하려는 것은 "이번 달 분위기"가 아니라 "이 방식이
  // 어르신들께 어떻게 받아들여지는가"이고, 그건 계절을 한 바퀴 돌려야 보입니다.
  const reactionYear = calYear;
  const reactionStats = useMemo(
    () => getReactionStats(`${reactionYear}-01-01`, `${reactionYear}-12-31`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, reactionYear],
  );

  return (
    <div className="min-h-screen bg-stone-50">
      <NavBar />
      <main className="mx-auto max-w-7xl px-6 py-6">
        <div className="mb-4">
          <h1 className="text-2xl font-bold tracking-tight">통계 · 분석</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            월 단위로 확인하는 자료입니다. 오늘 연락할 분은{" "}
            <Link to="/dashboard" className="font-medium text-foreground underline">
              대시보드
            </Link>
            에서 보세요.
          </p>
        </div>

        {/* 분석 기준 설명은 「판정 기준」 한 곳에만 둡니다.
            같은 설명이 두 화면에 있으면 둘이 갈라집니다 — 실제로 한쪽에만 여름·요일이
            무효라는 내용이 들어가 있었습니다. 기준을 묻는 사람은 관리자 설정에서 찾게
            되어 있으니, 그쪽으로 모으고 여기서는 길만 열어 둡니다. */}
        <Card className="mb-6 p-4">
          <Link to="/criteria" className="flex items-center gap-2.5 text-sm hover:underline">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <BookOpen className="h-4 w-4" />
            </span>
            <span className="flex-1">
              <span className="block font-semibold text-foreground">판정 기준 보기</span>
              <span className="block text-xs text-muted-foreground">
                이 화면의 숫자를 무엇으로 정하는지 — 기준선·점수·등급 문턱, 쓰지 않기로 정한 변수,
                분석에서 뺀 날까지
              </span>
            </span>
            <span className="text-muted-foreground">›</span>
          </Link>
        </Card>
        {/* 추이 그래프 — 기관 전체 흐름 */}
        {/* 넉 장이 같은 창을 봅니다. 화살표는 여기 한 곳에만 둡니다. */}
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <span className="text-sm font-semibold text-foreground">아래 그래프 넉 장의 기간</span>
            <span className="ml-2 text-sm tabular-nums text-muted-foreground">
              {trendRangeLabel}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              aria-label="이전 6개월"
              disabled={!canTrendOlder}
              onClick={() => setTrendOffset((v) => v + 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={!canTrendNewer}
              onClick={() => setTrendOffset(0)}
            >
              최근으로
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              aria-label="다음 6개월"
              disabled={!canTrendNewer}
              onClick={() => setTrendOffset((v) => Math.max(0, v - 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="p-5">
            <div className="mb-2">
              <h2 className="text-sm font-semibold">월별 평균 출석 인원</h2>
              <span className="text-xs text-muted-foreground">
                점을 클릭하면 해당 월 출석 명단을 볼 수 있습니다
              </span>
            </div>
            <div className="h-40 w-full cursor-pointer">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={attendanceTrendData}
                  onClick={(state: {
                    activePayload?: Array<{ payload: { year: number; month: number } }>;
                  }) => {
                    const point = state?.activePayload?.[0]?.payload;
                    if (point) openMonthAttendanceList(point.year, point.month);
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    width={28}
                    domain={[ATTENDANCE_TREND_MIN, "auto"]}
                    ticks={attendanceTrendTicks}
                  />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="출석인원"
                    stroke="#2563eb"
                    strokeWidth={2}
                    dot={{ r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {closedMonths.length > 0 && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                <b className="text-foreground">{closedMonths.join(", ")}</b>은 선이 끊겨 있습니다 —
                휴관·대체급식(밀키트) 기간이라 급식 자체가 없던 달입니다.{" "}
                <b className="text-foreground">이용이 줄어든 것이 아닙니다.</b>
              </p>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-2">
              <h2 className="text-sm font-semibold">월별 긴급·위기 인원 추이</h2>
              <span className="text-xs text-muted-foreground">
                막대를 클릭하면 해당 월의 명단을 볼 수 있습니다
              </span>
            </div>
            <div className="h-40 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={riskTrendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={28} allowDecimals={false} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar
                    dataKey="긴급"
                    fill="#ef4444"
                    radius={[3, 3, 0, 0]}
                    cursor="pointer"
                    onClick={(data: { payload: { year: number; month: number } }) =>
                      openMonthRiskList(data.payload.year, data.payload.month, "crisis")
                    }
                  />
                  <Bar
                    dataKey="위기"
                    fill="#f59e0b"
                    radius={[3, 3, 0, 0]}
                    cursor="pointer"
                    onClick={(data: { payload: { year: number; month: number } }) =>
                      openMonthRiskList(data.payload.year, data.payload.month, "caution")
                    }
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>

        {/* 월별 「자료에서 처음 확인된 어르신」 + 월별 확인 활동 */}
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card className="p-5">
            <div className="mb-2">
              <h2 className="text-sm font-semibold">월별 자료에서 처음 확인된 어르신</h2>
              <span className="text-xs text-muted-foreground">
                막대를 클릭하면 그 달에 처음 오신 분 명단을 볼 수 있습니다
              </span>
            </div>
            <div className="h-40 w-full cursor-pointer">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={newResidentTrend}
                  onClick={(state: {
                    activePayload?: Array<{ payload: { year: number; month: number } }>;
                  }) => {
                    const p = state?.activePayload?.[0]?.payload;
                    if (p) openNewResidentList(p.year, p.month);
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={28} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="처음확인" fill="#0ea5e9" radius={[3, 3, 0, 0]} cursor="pointer" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              전체 명부 {residents.length}명 · 최근 달에 새로 오시기 시작한 분이 많으면 그만큼
              기준선이 짧아, 판정이 보수적으로 나옵니다.
            </p>
          </Card>

          <Card className="p-5">
            <div className="mb-2">
              <h2 className="text-sm font-semibold">월별 개입 활동</h2>
              <span className="text-xs text-muted-foreground">
                막대를 클릭하면 그 달의 확인 기록을 볼 수 있습니다
              </span>
            </div>
            <div className="h-40 w-full cursor-pointer">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={followupTrend}
                  onClick={(state: {
                    activePayload?: Array<{ payload: { year: number; month: number } }>;
                  }) => {
                    const p = state?.activePayload?.[0]?.payload;
                    if (p) openFollowupList(p.year, p.month);
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={28} allowDecimals={false} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="확인완료" fill="#94a3b8" radius={[3, 3, 0, 0]} cursor="pointer" />
                  <Bar dataKey="개입필요" fill="#dc2626" radius={[3, 3, 0, 0]} cursor="pointer" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              &lsquo;개입 필요&rsquo;가 확인 완료 대비 높을수록 명단이 정확했다는 뜻입니다(지원 필요
              비율).
            </p>
          </Card>
        </div>

        {/* 어르신 반응 — 연 단위.
            「도움 필요 비율」은 담당자가 판단한 값입니다. 어르신께 이 전화가 어떻게
            닿았는지는 출석률로도, 개입 여부로도 나오지 않습니다. */}
        <Card className="mt-6 p-5">
          <div className="mb-3">
            <h2 className="text-sm font-semibold">
              어르신 반응 · {reactionYear}년 ({reactionYear}-01-01 ~ 12-31)
            </h2>
            <span className="text-xs text-muted-foreground">
              연락드렸을 때 어르신이 어떻게 받아들이셨는지 담당자가 눌러 둔 값입니다.{" "}
              <b className="text-foreground">안 고른 기록은 분모에서 뺍니다</b> — 억지로 반반 나누면
              없는 이야기를 만듭니다. 한 달 치는 표본이 적어 흔들리므로 연 단위로 냅니다.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">😊 반가워하심</div>
              <div className="mt-1 text-2xl font-bold text-emerald-700">
                {reactionStats.positive}건
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">😕 불편해하심</div>
              <div className="mt-1 text-2xl font-bold text-amber-700">
                {reactionStats.negative}건
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">반가워하신 비율</div>
              <div className="mt-1 text-2xl font-bold">
                {reactionStats.ratio === null ? "—" : `${reactionStats.ratio}%`}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {reactionStats.ratio === null
                  ? `표본 ${reactionStats.answered}건 — ${REACTION_MIN_SAMPLE}건부터 보여드립니다`
                  : `표본 ${reactionStats.answered}건`}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">반응을 적은 비율</div>
              <div className="mt-1 text-2xl font-bold">
                {reactionStats.total === 0
                  ? "—"
                  : `${Math.round((reactionStats.answered / reactionStats.total) * 100)}%`}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                올해 확인 기록 {reactionStats.total}건 중 {reactionStats.answered}건
              </div>
            </div>
          </div>
          {/* ★ 숫자와 같은 표본 문턱을 씁니다.
              예전에는 막대만 게이트가 없어서, 「반가워하신 비율 —」 「표본 3건 —
              10건부터 보여드립니다」라고 적어 놓고 바로 아래 초록 막대가 100%로
              꽉 찼습니다. 숫자를 숨긴 뜻이 사라집니다. */}
          {reactionStats.ratio !== null && (
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-stone-200">
              <div className="h-full bg-emerald-500" style={{ width: `${reactionStats.ratio}%` }} />
            </div>
          )}
        </Card>

        {/* 대응 이력 · 도움 필요 비율 */}
        <Card className="mt-6 p-5">
          <div className="mb-3">
            <h2 className="text-sm font-semibold">
              대응 이력 · 도움 필요 비율 (전체 누적 · <b className="text-primary">기록 건수</b>)
            </h2>
            {/* ★ 단위를 못박습니다.
                대시보드 「연락 드린 분」은 **사람 수**(한 분당 마지막 기록 하나)이고 여기는
                **기록 건수**입니다. 한 어르신께 세 번 거셨으면 저기서는 1명, 여기서는 3건이라
                부재중이 훨씬 많아 보입니다. 안 적어두면 둘 중 하나를 틀린 수로 여기게 됩니다. */}
            <span className="text-xs text-muted-foreground">
              긴급·위기로 분류된 어르신을 확인한 결과를{" "}
              <b className="text-foreground">처음부터 모두 더한</b> 값입니다. 도움 필요 비율은
              비율이라 한 달치로는 표본이 적어 크게 흔들립니다. 그래서 누적으로 냅니다. 이번 달에
              얼마나 확인했는지는 왼쪽에 따로 적었습니다.
              <br />
              <b className="text-foreground">
                여기는 「기록 건수」이고, 대시보드의 「연락 드린 분」은 「사람 수」입니다.
              </b>{" "}
              한 어르신께 세 번 거셨으면 대시보드에는 1명, 여기에는 3건으로 잡힙니다 — 그래서
              부재중이 더 많아 보입니다. 두 수가 다른 것이 맞습니다.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {/* 네 숫자 전부 누르면 그 기록이 누구의 것인지 열립니다.
                「27건」이 스물일곱 분인지 세 분께 아홉 번씩인지는 숫자만 봐서는 모릅니다. */}
            <button
              type="button"
              onClick={() => openOutcomeList("all")}
              className="group -mx-2 rounded-lg px-2 py-1.5 text-left ring-1 ring-transparent transition hover:bg-stone-100 hover:ring-stone-200"
            >
              <div className="text-xs text-muted-foreground">
                기록 전체
                <span className="ml-1 opacity-0 transition-opacity group-hover:opacity-100">›</span>
              </div>
              <div className="mt-1 text-2xl font-bold">{followupStats.checked}건</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                이번 {calMonth}월 {monthFollowupStats.checked}건
              </div>
            </button>
            <button
              type="button"
              onClick={() => openOutcomeList("needed")}
              className="group -mx-2 rounded-lg px-2 py-1.5 text-left ring-1 ring-transparent transition hover:bg-stone-100 hover:ring-stone-200"
            >
              <div className="text-xs text-muted-foreground">
                도움이 더 필요
                <span className="ml-1 opacity-0 transition-opacity group-hover:opacity-100">›</span>
              </div>
              <div className="mt-1 text-2xl font-bold text-red-600">{followupStats.needed}건</div>
            </button>
            <button
              type="button"
              onClick={() => openOutcomeList("notNeeded")}
              className="group -mx-2 rounded-lg px-2 py-1.5 text-left ring-1 ring-transparent transition hover:bg-stone-100 hover:ring-stone-200"
            >
              <div className="text-xs text-muted-foreground">
                지금은 괜찮으심
                <span className="ml-1 opacity-0 transition-opacity group-hover:opacity-100">›</span>
              </div>
              <div className="mt-1 text-2xl font-bold text-muted-foreground">
                {followupStats.notNeeded}건
              </div>
            </button>
            <button
              type="button"
              onClick={() => openOutcomeList("no_answer")}
              className="group -mx-2 rounded-lg px-2 py-1.5 text-left ring-1 ring-transparent transition hover:bg-stone-100 hover:ring-stone-200"
            >
              <div className="text-xs text-muted-foreground">
                부재중
                <span className="ml-1 opacity-0 transition-opacity group-hover:opacity-100">›</span>
              </div>
              <div className="mt-1 text-2xl font-bold text-amber-700">
                {followupStats.noAnswer}건
              </div>
            </button>
            <div>
              <div className="text-xs text-muted-foreground">도움 필요 비율</div>
              {/* 표본이 적으면 숫자가 아니라 우연입니다. 3건 중 1건이면 33%, 2건 중 1건이면
                  50% — 도구가 달라진 게 아니라 표본이 작은 것입니다. 그 숫자로 "쓸모
                  있는가"를 말하면 안 됩니다. */}
              {decidedCount < PRECISION_MIN_SAMPLE ? (
                <div className="mt-1 text-lg font-semibold text-muted-foreground">집계 전</div>
              ) : (
                <div className="mt-1 text-2xl font-bold text-primary">
                  {followupStats.precision === null ? "–" : `${followupStats.precision}%`}
                </div>
              )}
            </div>
          </div>
          {/* 부재중을 분모에 넣으면 도움 필요 비율이 실제보다 낮게 나옵니다 — 확인을 마친 것이
              아니라 아직 못 만난 것이므로, 판단이 맞았는지 따질 대상이 아닙니다. */}
          {decidedCount < PRECISION_MIN_SAMPLE && (
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
              <b className="font-semibold">도움 필요 비율은 아직 내지 않습니다.</b> 판단이 끝난
              확인이 {decidedCount}건뿐이라, 지금 비율을 내면 한 건이 들고 날 때마다 수십 %p씩
              흔들립니다. <b className="font-semibold">{PRECISION_MIN_SAMPLE}건</b>이 쌓이면
              보여드립니다.
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            도움 필요 비율 = 도움이 더 필요 ÷ 확인을 마친 전체 건수.{" "}
            <b className="font-medium text-foreground">부재중은 분모에서 뺍니다</b> — 아직 확인하지
            못한 건이라 판단이 맞았는지 따질 수 없습니다.
          </p>
          {followupStats.checked === 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              아직 확인 기록이 없습니다. 대시보드에서 어르신을 확인한 뒤 &lsquo;확인 기록&rsquo;을
              남겨주세요.
              {!session && " (기록에는 로그인이 필요합니다)"}
            </p>
          )}
        </Card>

        {/* 갑자기 늘거나 줄어든 날 */}
        <Card className="mt-6 p-5">
          <details>
            <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-2">
              <span>
                <span className="text-sm font-semibold text-foreground">
                  갑자기 늘거나 줄어든 날
                </span>
                <span className="ml-2 text-xs font-medium text-sky-700">펼쳐 보기 ▾</span>
              </span>
              <span className="text-xs text-muted-foreground">
                전체 운영일 {operatingDayCount}일 중 {shifts.length}일
              </span>
            </summary>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              그 달 평균과 요일 버릇까지 감안해 &ldquo;이 정도는 왔어야 할 인원&rdquo;과 비교합니다.
              15% 넘게 어긋난 날만 모았습니다.
            </p>
            {shifts.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                크게 어긋난 날이 없습니다. 자료가 아직 적을 때도 이렇게 나옵니다.
              </p>
            ) : (
              <ul className="mt-3 max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {shifts.map((sh) => (
                  <li
                    key={sh.date}
                    className={`rounded-md border px-3 py-2 text-sm ${
                      sh.direction === "surge"
                        ? "border-blue-200 bg-blue-50/60"
                        : "border-amber-200 bg-amber-50/60"
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="font-medium tabular-nums">
                        {formatDateWithWeekday(sh.date)}
                      </span>
                      <span
                        className={`text-xs font-semibold tabular-nums ${
                          sh.direction === "surge" ? "text-blue-700" : "text-amber-800"
                        }`}
                      >
                        {sh.count}명 · 예상 {sh.expected}명 대비 {sh.deltaPct > 0 ? "+" : ""}
                        {sh.deltaPct}%
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {sh.reasons.length > 0 ? (
                        sh.reasons.join(" · ")
                      ) : (
                        <span className="font-medium text-red-700">
                          짚이는 사정이 없습니다 — 왜 그랬는지 확인해보셔야 합니다
                        </span>
                      )}
                      {sh.direction === "surge" && (
                        <span className="ml-1 text-foreground">
                          · 이런 날 <b>안 오신 분</b>이 가장 눈여겨볼 분입니다
                        </span>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </Card>

        {/* 행사일 결석 — 평소보다 많이 오신 날에 안 오신 분 */}
        {crowdedDays.length > 0 && (
          <Card className="mt-6 overflow-hidden border-rose-200 p-0">
            <div className="flex items-start gap-2.5 border-b border-rose-200 bg-rose-50/70 px-5 py-4">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-600">
                <UtensilsCrossed className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold">{calMonth}월 행사일인데 안 오신 어르신</h2>
                <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                  식단표에 행사가 적혀 있고{" "}
                  <b className="font-medium text-foreground">실제로 평소보다 많이 오신 날</b>
                  입니다. 그런 날 안 오신 것은 못 오실 사정이 있었다는 뜻일 수 있습니다.
                </p>
              </div>
            </div>

            <div className="divide-y">
              {crowdedDays.map((d) => (
                <div key={d.date} className="px-5 py-3.5">
                  <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <span className="text-sm font-semibold tabular-nums">
                      {formatDateWithWeekday(d.date)}
                    </span>
                    <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                      {d.eventLabel}
                    </span>
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-rose-800">
                      평소의 {d.lift}배
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      출석률 {d.dayRate}% (평소 {d.monthTypicalRate}%) · 안 오신 분{" "}
                      {d.absentees.length}명
                    </span>
                  </div>
                  {d.absentees.length === 0 ? (
                    <p className="text-xs text-muted-foreground">모두 오셨습니다.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {d.absentees.map((r) => (
                        <Link
                          key={r.id}
                          to="/resident/$id"
                          params={{ id: r.id }}
                          className="rounded-md border bg-white px-2 py-1 text-xs hover:border-rose-300 hover:bg-rose-50"
                        >
                          <ResidentName resident={r} />
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {quietEventDays.length > 0 && (
              <div className="border-t bg-stone-50 px-5 py-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <b className="font-medium text-foreground">행사였지만 평소와 비슷했던 날</b> —
                  이날 결석은 특별히 강한 신호가 아니라서 위 목록에 넣지 않았습니다.
                </p>
                <ul className="mt-1.5 space-y-1">
                  {quietEventDays.map((d) => (
                    <li key={d.date} className="flex flex-wrap items-baseline gap-2 text-xs">
                      <span className="w-10 shrink-0 tabular-nums text-muted-foreground">
                        {d.date.slice(5)}
                      </span>
                      <span className="text-foreground">{d.eventLabel}</span>
                      <span className="tabular-nums text-muted-foreground">
                        평소의 {d.lift}배 (출석률 {d.dayRate}% vs 평소 {d.monthTypicalRate}%)
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}

        {crowdedDays.length === 0 && quietEventDays.length > 0 && (
          <p className="mt-6 rounded-md border bg-white px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            {calMonth}월 식단표에 행사가 {quietEventDays.length}일 적혀 있었지만, 어느 날도 평소보다
            사람이 몰리지 않았습니다 (
            {quietEventDays
              .map((d) => `${d.date.slice(5)} ${d.eventLabel} ${d.lift}배`)
              .join(" · ")}
            ). 그래서 이달에는 &ldquo;행사일 결석&rdquo;을 강한 신호로 보지 않습니다.
          </p>
        )}

        {/* 관측 기준 안내 + 판단 어려움 명단 */}
        <Card className="mt-6 p-5">
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">관측 기준 · 판단 어려움 명단</h2>
            <Button asChild variant="outline" size="sm">
              <Link to="/admin" search={{ tab: "holidays" }}>
                <Settings2 className="mr-1.5 h-3.5 w-3.5" />
                휴관일 등록·수정
              </Link>
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            판정은 정해진 산술식으로만 합니다(같은 입력 → 같은 결과). 겨울(1월·12·2월)은 불필요한
            알림이 늘어 <b className="font-medium text-foreground">계절 반영</b>을 자동 적용하고,
            명절 전후는 위험 점수 계산을 잠시 멈춥니다. 장날·기초연금·비·메뉴·여름·요일은 4년치
            검증에서 효과가 확인되지 않아(전부 3%p 미만) 판정에 쓰지 않습니다. 공휴일·리모델링
            휴관은 애초에 운영일에서 빠집니다.
          </p>

          {/* 판정을 해 본 적조차 없는 분들.
              getUnanalyzable 은 "판정에서 빠진 분일수록 화면에 이름이 남아 있어야
              합니다"라는 주석과 함께 만들어졌는데, **아무 화면도 부르지 않았습니다.**
              회원번호가 깨졌거나 기록이 3주도 안 된 분은 모든 계산에서 말없이 빠지고,
              어디에도 이름이 없었습니다. */}
          {unanalyzable.length > 0 && (
            <details className="mt-3 border-t border-stone-100 pt-3">
              <summary className="cursor-pointer list-none text-sm font-medium text-red-700 hover:text-red-900">
                ⚠️ 판정해 본 적이 없는 분 {unanalyzable.length}명 — 자료가 모자라거나 깨져서 ▾
              </summary>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                이분들은 긴급·위기·관심 어디에도 안 나옵니다.{" "}
                <b>안전해서가 아니라 판정을 못 해서</b>입니다. 회원번호·이름이 깨진 분은 자료를
                고쳐야 하고, 기록이 아직 3주에 못 미치는 분은 시간이 지나면 자동으로 판정에
                들어옵니다.
              </p>
              <ul className="mt-2 space-y-1">
                {unanalyzable.slice(0, 50).map((u) => (
                  <li
                    key={u.resident.id}
                    className="flex flex-wrap items-center gap-2 rounded border border-red-100 bg-red-50/40 px-3 py-1.5 text-xs"
                  >
                    <span className="font-medium">
                      <ResidentName resident={u.resident} />
                    </span>
                    <span className="rounded-full border border-red-200 bg-white px-1.5 py-0.5 text-[10px] text-red-700">
                      {u.reason}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">{u.detail}</span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {u.lastVisit ? `마지막 ${u.lastVisit}` : "방문 기록 없음"}
                      {u.daysSince !== null ? ` · ${u.daysSince}일 전` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {unanalyzable.length > 50 && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  위 50명만 보여드립니다 (전체 {unanalyzable.length}명).
                </p>
              )}
            </details>
          )}

          {/* 「⚪ 판단 어려움 N명」 상자를 뺐습니다.
              원래 월 1~2회 이하로 오시는 분(평소 출석 7% 미만)을 모아 두던 자리입니다. 두 달을
              안 나오셔도 그분께는 평소와 다르지 않아 점수를 매길 수 없는데, 화면에 64명이라는
              큰 숫자로 서 있으니 "아직 못 본 사람이 64명 남았다"로 읽혔습니다. 판정하지 않기로
              한 분들을 숫자로 세워두면, 보지 않아도 되는 목록에 자꾸 눈이 갑니다.

              계산에서 뺀 것이 아니라 이 상자만 뺐습니다 — worklist.undetectable 은 그대로 있고,
              어르신 한 분 상세 화면에 들어가면 「급식 기록만으로는 판단하기 어려움」이라고 그대로
              나옵니다. 다시 명단으로 필요해지면 이 자리에 되살리면 됩니다.

              ⚠️ 여기 있던 「판단 어려움」과, 60일 넘게 안 나오셔서 판정을 멈춘 분(notEnough)은
                 다릅니다. 이름만 같고 서로 다른 통입니다. 후자는 아직 어느 화면에도 명단이
                 없습니다. */}
        </Card>

        <ListDialog
          open={listDialog !== null}
          onOpenChange={(open) => !open && setListDialog(null)}
          title={listDialog?.title ?? ""}
          entries={listDialog?.entries ?? []}
          unit={listDialog?.unit ?? "명"}
        />
      </main>
    </div>
  );
}
