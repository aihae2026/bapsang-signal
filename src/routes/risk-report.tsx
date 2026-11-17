import { ResidentName, residentSubtitle } from "@/components/ResidentName";
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileText, Printer } from "lucide-react";
import { NavBar } from "@/components/NavBar";
import { printPage } from "@/lib/print";
import { toast } from "sonner";
import { ResidentAvatar } from "@/components/ResidentAvatar";
import { RiskBadge } from "@/components/RiskBadge";
import {
  DATA_END_STR,
  DATA_START_STR,
  RESULT_KIND_META,
  RISK_BADGE_STYLES,
  RISK_LABELS,
  TODAY_DATE,
  getActiveResidents,
  getRegisteredCountAsOf,
  getAiRiskAssessment,
  getCurrentRisk,
  getMonthDetectedIds,
  getDisplayStatus,
  getLastAttendanceDate,
  getLatestFollowup,
  getMonthlyStats,
  useDataVersion,
  type RiskLevel,
} from "@/lib/attendance-engine";

export const Route = createFileRoute("/risk-report")({
  head: () => ({
    meta: [
      { title: "위험군 리포트 | 밥상위의 신호" },
      {
        name: "description",
        content: "기간을 선택해 긴급·위기 어르신을 한 페이지로 정리한 리포트입니다.",
      },
    ],
  }),
  component: RiskReportPage,
});

const SEVERITY_ORDER: Record<RiskLevel, number> = {
  crisis: 0,
  caution: 1,
  concern: 2,
  normal: 3,
  // 판단하지 않은 분은 맨 아래. 위에서부터 읽는 목록이라, 판단한 분이 먼저여야 합니다.
  unknown: 4,
};

function getReportMonths(): { year: number; month: number; label: string }[] {
  const [startY, startM] = DATA_START_STR.split("-").map(Number);
  const [endY, endM] = DATA_END_STR.split("-").map(Number);
  const months: { year: number; month: number; label: string }[] = [];
  let y = startY;
  let m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    months.push({ year: y, month: m, label: `${y}년 ${m}월` });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

function RiskReportPage() {
  const version = useDataVersion();
  const months = getReportMonths();
  const todayIdx = months.findIndex(
    (m) => m.year === TODAY_DATE.getFullYear() && m.month === TODAY_DATE.getMonth() + 1,
  );
  const defaultIdx = todayIdx >= 0 ? todayIdx : months.length - 1;

  const [startIdx, setStartIdx] = useState(defaultIdx);
  const [endIdx, setEndIdx] = useState(defaultIdx);

  // ★ 자리번호를 **언제나 목록 안으로 가둡니다.**
  //
  //   months 는 자료가 늘면 길이가 바뀝니다. 그런데 startIdx·endIdx 는 useState 에
  //   남아 있어서, 자료가 다시 불려 목록이 짧아지는 순간 months[idx] 가 undefined 가
  //   되고 바로 아래 `.year` 에서 화면 전체가 터집니다 —
  //   「This page didn't load」라는 **영어 오류 화면**이 뜹니다.
  //   드물게 나지만, 심사 시연 중에 나면 그것으로 끝입니다.
  const lastIdx = Math.max(0, months.length - 1);
  const safeStart = Math.min(Math.max(0, startIdx), lastIdx);
  const safeEnd = Math.min(Math.max(safeStart, endIdx), lastIdx);
  const rangeMonths = months.slice(safeStart, safeEnd + 1);
  const startMonth = months[safeStart];
  const endMonth = months[safeEnd];
  const endMonthEnd = new Date(endMonth.year, endMonth.month, 0);
  // ⚠️ **여기 있어야 합니다.** 아래 entries 계산(.map 안)에서 바로 쓰는데, 선언이 그
  // 아래에 있으면 TDZ 로 터집니다 — 그것도 tsc 가 안 잡아 주는 자리입니다(.map 에
  // 넘긴 화살표 함수 안이라 "선언 전 사용" 검사가 안 걸립니다). 리포트 화면이
  // 통째로 하얗게 뜹니다.
  // 자료가 있는 마지막 날을 넘지 않습니다 — 이번 달을 보면 월말이 아직 안 왔습니다.
  // (대시보드에서 같은 실수로 「09-28 예정이었는데 지났습니다」가 9월 17일에 떴습니다.)
  const endMonthEndRaw = `${endMonth.year}-${String(endMonth.month).padStart(2, "0")}-${String(endMonthEnd.getDate()).padStart(2, "0")}`;
  const endMonthEndStr = endMonthEndRaw > DATA_END_STR ? DATA_END_STR : endMonthEndRaw;
  const isRange = rangeMonths.length > 1;

  const activeResidents = getActiveResidents();

  // ★ 「그 달에 감지된 분」을 대시보드·통계와 **같은 함수**로 구합니다.
  //
  //   이 문서는 인쇄해서 행정복지센터·사례관리팀에 냅니다. 그런데 화면(대시보드)이
  //   「9월 긴급 11명」이라고 하는데 인쇄물은 「긴급 4명」이었습니다 — 확인을 마쳐
  //   판정이 멈춘 분(입원·일자리 참여)과 종결한 분이 여기서만 빠졌기 때문입니다.
  //   이 문서 스스로 「기간 내 한 번이라도 긴급·위기였던 분을 모두 표시」라고
  //   적어 두었는데 그 말과도 달랐습니다.
  const detectedByLevel = useMemo(() => {
    const crisis = new Set<string>();
    const caution = new Set<string>();
    for (const { year, month } of rangeMonths) {
      // ★ 조회 달이 **자료의 마지막 달**이면 그 달 이후에 적은 기록도 함께 셉니다.
      //   자료 기준일이 달을 넘기면 오늘 전화하고 적은 기록의 날짜가 다음 달이 됩니다.
      //   달 접두어로만 거르면 그 기록이 어디에도 안 잡혀 **확인할수록 그 달 인원이
      //   줄어듭니다.** 대시보드는 이미 같은 방식으로 셉니다.
      const after =
        `${year}-${String(month).padStart(2, "0")}` === DATA_END_STR.slice(0, 7)
          ? DATA_END_STR
          : undefined;
      for (const id of getMonthDetectedIds(year, month, "crisis", after)) crisis.add(id);
      for (const id of getMonthDetectedIds(year, month, "caution", after)) caution.add(id);
    }
    return { crisis, caution };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeMonths, version]);
  const detected = useMemo(
    () => new Set([...detectedByLevel.crisis, ...detectedByLevel.caution]),
    [detectedByLevel],
  );

  if (!startMonth || !endMonth) {
    return <div className="p-6 text-sm text-muted-foreground">자료를 불러오는 중입니다…</div>;
  }

  const entries = activeResidents
    .map((r) => {
      const monthlyLevels = rangeMonths.map(({ year, month, label }) => ({
        year,
        month,
        label,
        level: getCurrentRisk(r, new Date(year, month, 0)).level,
      }));
      const endLevel = monthlyLevels[monthlyLevels.length - 1]?.level ?? "normal";
      const worstLevel = monthlyLevels.reduce(
        (worst, m) => (SEVERITY_ORDER[m.level] < SEVERITY_ORDER[worst] ? m.level : worst),
        endLevel,
      );
      return {
        resident: r,
        stats: getMonthlyStats(r, endMonth.year, endMonth.month),
        assessment: getAiRiskAssessment(r, endMonthEnd),
        lastAttendance: getLastAttendanceDate(r, endMonthEndStr),
        monthlyLevels,
        endLevel,
        worstLevel,
      };
    })
    // 판정이 멈춰 지금은 등급이 없는 분도, 그 기간에 감지된 적이 있으면 넣습니다.
    // 그때 어떤 등급이었는지는 확인 기록에 남아 있습니다(followups.risk_level).
    .filter(
      (e) => e.worstLevel === "crisis" || e.worstLevel === "caution" || detected.has(e.resident.id),
    )
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.worstLevel] - SEVERITY_ORDER[b.worstLevel] ||
        SEVERITY_ORDER[a.endLevel] - SEVERITY_ORDER[b.endLevel] ||
        a.stats.rate - b.stats.rate,
    );

  // 같은 어르신이 기간 내 여러 달 위기·주의였어도 1명으로만 집계합니다(최고 등급 기준 중복 제거).
  //
  // ★ 머리글 숫자를 **목록과 같은 모수**로 셉니다.
  //
  //   예전에는 지금 등급(worstLevel)만 셌습니다. 그런데 목록에는 「기간 내 한 번이라도
  //   긴급·위기였던 분」을 넣습니다 — 확인을 마쳐 판정이 멈춘 분(입원·일자리 참여)과
  //   종결한 분은 지금 등급이 없어 목록에만 있고 숫자에는 없었습니다. 그래서 대시보드가
  //   「9월 긴급 11명」이라 할 때 이 인쇄물은 「긴급 4명」이었고, 이 문서 스스로
  //   「기간 내 한 번이라도 … 모두 표시」라고 적어 둔 말과도 어긋났습니다.
  //
  //   외부 기관에 나가는 문서라 두 숫자가 다르면 어느 쪽도 못 믿게 됩니다.
  const crisisIds = new Set(
    entries
      .filter((e) => e.worstLevel === "crisis" || detectedByLevel.crisis.has(e.resident.id))
      .map((e) => e.resident.id),
  );
  const cautionIds = new Set(
    entries
      .filter(
        (e) =>
          !crisisIds.has(e.resident.id) &&
          (e.worstLevel === "caution" || detectedByLevel.caution.has(e.resident.id)),
      )
      .map((e) => e.resident.id),
  );
  const crisisCount = crisisIds.size;
  const cautionCount = cautionIds.size;
  const rangeLabel = isRange ? `${startMonth.label} ~ ${endMonth.label}` : endMonth.label;
  // 총원은 리포트 끝 달 시점에 등록돼 있던 어르신 수(2025년 달이면 396명보다 적음).
  const registeredCount = getRegisteredCountAsOf(endMonthEndStr);

  return (
    <div className="min-h-screen bg-stone-50 print:bg-white">
      <div className="print:hidden">
        <NavBar />
      </div>
      <main className="mx-auto max-w-4xl px-6 py-8 print:px-0 print:py-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">위험군 리포트</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {rangeLabel} 기준 · 등록 {registeredCount}명 중 긴급 {crisisCount}명 · 위기{" "}
              {cautionCount}명
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="print:hidden"
            onClick={() =>
              printPage(() =>
                toast.error("인쇄 창이 열리지 않는 자리입니다", {
                  description:
                    "이 화면이 다른 창 안에 끼워져 있어 브라우저가 인쇄 대화상자를 막습니다. 크롬·엣지에서 같은 주소를 열고 인쇄해주세요.",
                }),
              )
            }
          >
            <Printer className="mr-2 h-4 w-4" />
            인쇄하기
          </Button>
        </div>

        <div className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
          <Select
            value={String(startIdx)}
            onValueChange={(v) => {
              const idx = Number(v);
              setStartIdx(idx);
              if (idx > endIdx) setEndIdx(idx);
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="시작 월" />
            </SelectTrigger>
            <SelectContent>
              {months.map((m, i) =>
                i <= endIdx ? (
                  <SelectItem key={`${m.year}-${m.month}`} value={String(i)}>
                    {m.label}
                  </SelectItem>
                ) : null,
              )}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">~</span>
          <Select
            value={String(endIdx)}
            onValueChange={(v) => {
              const idx = Number(v);
              setEndIdx(idx);
              if (idx < startIdx) setStartIdx(idx);
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="종료 월" />
            </SelectTrigger>
            <SelectContent>
              {months.map((m, i) =>
                i >= startIdx ? (
                  <SelectItem key={`${m.year}-${m.month}`} value={String(i)}>
                    {m.label}
                  </SelectItem>
                ) : null,
              )}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            기간 내 한 번이라도 긴급·위기였던 어르신을 모두 표시하며, 여러 달 반복되어도 최고 등급
            기준 1명으로만 집계합니다.
          </span>
        </div>

        <div className="space-y-3">
          {entries.map(
            ({
              resident,
              stats,
              assessment,
              lastAttendance,
              endLevel,
              worstLevel,
              monthlyLevels,
            }) => (
              <Card key={resident.id} className="p-4 print:break-inside-avoid print:shadow-none">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <ResidentAvatar
                      seed={resident.id}
                      photoUrl={resident.photoUrl}
                      size={36}
                      className="mt-0.5 print:hidden"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <Link
                          to="/intake/$id"
                          params={{ id: resident.id }}
                          className="text-sm font-semibold text-foreground hover:underline print:text-black"
                          title="연계 의뢰서 — 이분의 기록을 A4 한 장으로"
                        >
                          <ResidentName resident={resident} />
                        </Link>
                        <RiskBadge level={worstLevel} />
                        {/* 위험 등급과 사례 처리 상태는 다른 정보입니다. 섞지 않고 나란히. */}
                        {(() => {
                          const st = getDisplayStatus(resident);
                          if (st.label === RISK_LABELS[worstLevel]) return null;
                          return (
                            <span
                              title={st.hint}
                              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${st.style}`}
                            >
                              {st.label}
                            </span>
                          );
                        })()}
                        {isRange && endLevel !== worstLevel && (
                          <span className="text-[11px] text-muted-foreground">
                            (현재 {endMonth.label}: {RISK_LABELS[endLevel]})
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {residentSubtitle(resident)}
                        <Link
                          to="/intake/$id"
                          params={{ id: resident.id }}
                          className="ml-2 inline-flex items-center gap-1 rounded border border-stone-300 px-1.5 py-0.5 text-[11px] text-foreground hover:bg-stone-50 print:hidden"
                        >
                          <FileText className="h-3 w-3" />
                          연계 의뢰서
                        </Link>
                      </div>
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>
                      {endMonth.label} 출석률 {stats.rate}% ({stats.present}/{stats.total}일)
                    </div>
                    {assessment.consecutiveAbsence > 0 && (
                      <div className="font-medium text-red-600">
                        연속결석 {assessment.consecutiveAbsence}일
                      </div>
                    )}
                    <div>최근 출석일 {lastAttendance ?? "기록 없음"}</div>
                  </div>
                </div>
                {/* 최신 확인 결과를 판정문보다 **먼저** 보여줍니다.
                    담당자가 이미 전화해서 "여행 가셨다"를 확인했는데도 이 화면은 계속
                    "즉각적인 가정방문이 필요합니다"라고 말하고 있었습니다. 같은 어르신을
                    두고 화면마다 다른 말을 하면, 둘 다 안 믿게 됩니다.
                    판정문은 출결 계산 결과일 뿐이고, 사람이 확인한 것이 더 최신입니다. */}
                {(() => {
                  const f = getLatestFollowup(resident.id, endMonthEndStr);
                  if (!f) return null;
                  const label = f.resultKind
                    ? (RESULT_KIND_META[f.resultKind]?.label ?? f.resultKind)
                    : f.outcome === "needed"
                      ? "도움이 더 필요"
                      : f.outcome === "no_answer"
                        ? "연락되지 않음"
                        : "지금은 괜찮으심";
                  return (
                    <div className="mt-2 rounded-md border border-sky-200 bg-sky-50/60 px-2.5 py-1.5 text-[12px] leading-relaxed text-sky-900 print:border-black print:bg-white print:text-black">
                      <b className="font-semibold">담당자 확인 결과</b> {label}
                      <span className="text-sky-900/70"> · 확인일 {f.checkedAt}</span>
                      {/* 종결 단추는 「다시 뜨지 않게」 하려고 2999-12-31 을 심습니다
                          (976년치 안심). 그 날짜를 그대로 찍으면 인쇄물에
                          「다음 확인 2999-12-31」이 남아, 받는 기관은 무슨 뜻인지
                          알 수 없습니다. 뜻으로 적습니다. */}
                      {f.snoozeUntil && (
                        <span className="text-sky-900/70">
                          {f.snoozeUntil === "2999-12-31"
                            ? " · 확인 대상에서 제외"
                            : ` · 다음 확인 ${f.snoozeUntil}`}
                        </span>
                      )}
                      {f.note && (
                        <span className="block text-sky-900/70">
                          {f.note.replace("[종결] ", "")}
                        </span>
                      )}
                    </div>
                  );
                })()}
                <p className="mt-2 text-sm leading-relaxed text-foreground">
                  {assessment.narrative}
                </p>
                {getLatestFollowup(resident.id, endMonthEndStr) && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    위 문단은 급식 출결을 계산한 결과입니다. 확인 결과가 더 최신이면 그쪽을
                    따르세요.
                  </p>
                )}
                {isRange && (
                  <div className="mt-3 flex flex-wrap gap-1 border-t pt-2">
                    {monthlyLevels.map((m) => (
                      <span
                        key={`${m.year}-${m.month}`}
                        className={`rounded border px-1.5 py-0.5 text-[10px] ${RISK_BADGE_STYLES[m.level]}`}
                      >
                        {m.month}월 {RISK_LABELS[m.level]}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
            ),
          )}
          {entries.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              선택한 기간에는 긴급·위기 어르신이 없습니다.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
