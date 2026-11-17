import { ResidentName, residentSubtitle } from "@/components/ResidentName";
import { RiskTrend } from "@/components/RiskTrend";
import { useMemo, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ArrowLeft, PhoneCall, Sparkles } from "lucide-react";
import { NavBar } from "@/components/NavBar";
import { FollowupDialog } from "@/components/FollowupDialog";
import { useSession } from "@/lib/use-session";
import { ResidentAvatar } from "@/components/ResidentAvatar";
import { RiskBadge } from "@/components/RiskBadge";
import {
  BASELINE_DAYS,
  DATA_END_STR,
  getAiRiskAssessment,
  getCurrentRisk,
  getResidentById,
  isClosedFollowup,
  getFirstAttendanceDate,
  getObservability,
  recordDateFor,
  getFollowupsForResident,
  getMonthOptions,
  getResidentCalendarMonths,
  useDataVersion,
  type Resident,
  type ResidentCalendarMonth,
  type ResidentDayStatus,
} from "@/lib/attendance-engine";

export const Route = createFileRoute("/resident/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `어르신 ${params.id.toUpperCase()} 상세 | 밥상위의 신호` },
      {
        name: "description",
        content: "어르신의 출석 달력과 위기 판단 근거를 확인합니다.",
      },
      { property: "og:title", content: "어르신 상세" },
      { property: "og:description", content: "출석 달력과 위기 판단 근거." },
    ],
  }),
  component: ResidentDetailPage,
});

const statusStyles: Record<ResidentDayStatus, { bg: string; label: string }> = {
  present: { bg: "bg-emerald-400", label: "출석" },
  absent: { bg: "bg-red-400", label: "결석" },
  none: { bg: "bg-stone-100", label: "기록 없음" },
};

function ResidentDetailPage() {
  const version = useDataVersion();
  const { id } = Route.useParams();
  const router = useRouter();
  // 달력은 기본으로 최근 6개월만 보여주고, 펼치면 첫 기록(2025년 포함)까지 전부 봅니다.
  const [showAllMonths, setShowAllMonths] = useState(false);
  const session = useSession();
  /**
   * 이 화면에서 바로 확인 기록을 남기고 고칩니다.
   *
   * 대시보드에서 이름을 눌러 여기로 오는 흐름이 실제 업무입니다 — 패턴을 보고, 전화하고,
   * 적습니다. 그런데 적으려면 대시보드로 되돌아가야 했습니다. 창 하나를 여기 두면
   * 그 왕복이 없어집니다. 창 안에 지난 기록을 고치는 기능이 이미 들어 있어서,
   * 「개입 이력을 여기서 편집」도 같이 됩니다.
   */
  const [followupOpen, setFollowupOpen] = useState(false);

  // 어느 시점 기준으로 볼지. 기본은 가장 최근 달. 과거 달을 고르면 그때까지의 자료만으로
  // 판단·달력을 다시 계산합니다("2025년 9월을 보면 그 이전 자료로 결과가 나와야 한다").
  const monthOptions = getMonthOptions();
  const latestKey = `${DATA_END_STR.slice(0, 4)}-${DATA_END_STR.slice(5, 7)}`;
  const [monthKey, setMonthKey] = useState(latestKey);
  const [asYear, asMonth] = monthKey.split("-").map(Number);
  const isLatest = monthKey === latestKey;
  // 선택한 달의 말일(자료 마지막 날 이후로는 넘어가지 않음)을 기준일로 씁니다.
  // 「지금 이분을 급식 기록으로 판정하고 있나」 — 배너와 아래 숫자 칸이 같은 답을 씁니다.
  const asOfStr = useMemo(() => {
    const lastDay = new Date(asYear, asMonth, 0).getDate();
    const s = `${asYear}-${String(asMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return s > DATA_END_STR ? DATA_END_STR : s;
  }, [asYear, asMonth]);
  const asOfDate = useMemo(() => {
    const [y, m, d] = asOfStr.split("-").map(Number);
    return new Date(y, m - 1, d);
  }, [asOfStr]);

  // 없는 ID일 때 residents[0]으로 갈아끼우면, 주소에 적힌 어르신과 화면에 보이는 어르신이
  // 서로 다른 사람이 됩니다. 퇴소·삭제된 어르신의 링크를 눌렀을 때 남의 기록을 보게 되므로
  // 조용히 대체하지 않고 찾을 수 없다고 말합니다.
  const resident = getResidentById(id);
  const risk = useMemo(
    () => (resident ? getCurrentRisk(resident, asOfDate) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resident, asOfDate, version],
  );
  const assessment = useMemo(
    () => (resident ? getAiRiskAssessment(resident, asOfDate) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resident, asOfDate, version],
  );
  // 배너와 아래 숫자 칸이 **같은 답**을 씁니다. 두 번 계산하면 언젠가 갈라집니다.
  const observability = useMemo(
    () => (resident ? getObservability(resident, asOfStr) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resident, asOfStr, version],
  );
  const judged = observability?.canJudge ?? false;
  // 사유를 확인해 기한까지 빼둔 분. 등급이 normal 로 덮여 있어 배지만으로는 구분이 안 됩니다.
  const snoozed = observability?.headline.includes("안심 처리") ?? false;
  const calendarMonths = useMemo(
    () =>
      resident
        ? getResidentCalendarMonths(resident, getFirstAttendanceDate(resident), asOfStr)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resident, asOfStr, version],
  );
  // 고른 달의 집계 — 상단 출석률과 아래 달력이 같은 값을 쓰게 하려고 한 군데서 꺼냅니다.
  const selectedMonthStat = calendarMonths.find(
    (m) => `${m.year}-${String(m.month).padStart(2, "0")}` === monthKey,
  );
  if (!resident || !risk || !assessment) return <ResidentNotFound id={id} />;

  return (
    <div className="min-h-screen bg-stone-50">
      <NavBar />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.history.back()}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            뒤로 (이전 목록)
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">기준 시점</span>
            <Select value={monthKey} onValueChange={setMonthKey}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...monthOptions].reverse().map((m) => (
                  <SelectItem
                    key={`${m.year}-${m.month}`}
                    value={`${m.year}-${String(m.month).padStart(2, "0")}`}
                  >
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!isLatest && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                과거 시점
              </span>
            )}
          </div>
        </div>

        {/* 상단 헤더 */}
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <ResidentAvatar seed={resident.id} photoUrl={resident.photoUrl} size={72} />
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-bold">
                    <ResidentName resident={resident} />
                  </h1>
                  <RiskBadge level={risk.level} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {residentSubtitle(resident)}
                  <RiskTrend resident={resident} className="ml-2 align-middle" />
                </p>
                <p className="mt-1 text-xs text-muted-foreground">특이사항: {resident.notes}</p>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground">{asMonth}월 출석률</div>
              {/* 판단에 쓸 날이 하나도 없는 달(공휴일·휴관·자료가 며칠뿐인 달)은 0%로 쓰면
                  한 번도 안 오신 것처럼 읽힙니다. 아래 달력과 같은 말을 씁니다. */}
              {/* ★ 아래 달력과 **같은 값**을 씁니다.
                  헤더는 getMonthlyStats(그 달 1일~말일)를, 달력 타일은
                  getResidentCalendarMonths(첫 급식 기록일부터)를 쓰고 있었습니다.
                  첫 기록이 그 달 중간인 분은 한 화면에서 이렇게 보였습니다 —
                    헤더    8월 출석률 70%   (14/20)
                    달력    2026년 8월 14/14 · 100%
                    막대    출석 14일 / 결석 0일
                  어느 쪽이 맞는지 화면에 알 방법이 없습니다. 달력이 쓰는 값으로 맞춥니다
                  — 바로 아래에 날짜별로 펼쳐져 있어 담당자가 직접 셀 수 있는 쪽입니다. */}
              {selectedMonthStat && selectedMonthStat.totalCount === 0 ? (
                <div className="text-lg font-semibold text-muted-foreground">판단 제외</div>
              ) : selectedMonthStat ? (
                <div className="text-3xl font-bold text-foreground">
                  {Math.round(
                    (selectedMonthStat.presentCount / selectedMonthStat.totalCount) * 100,
                  )}
                  %
                </div>
              ) : (
                <div className="text-lg font-semibold text-muted-foreground">기록 없음</div>
              )}
            </div>
          </div>
        </Card>

        {/* ★ 「이 어르신을 급식 기록으로 볼 수 있는가」 — 가장 먼저 답합니다.
            맞돌팀·사례관리팀이 회원번호로 찾아 들어왔을 때 가장 먼저 알아야 하는 것입니다.
            급식을 원래 안 쓰시는 분을 조회하면 화면이 「판단 어려움」만 보여주는데,
            그러면 "이 도구 안 되네"로 읽힙니다. 안 되는 것이 아니라 **볼 자료가 없는
            것**이고, 그 둘은 담당자가 다음에 할 일이 완전히 다릅니다. */}
        {(() => {
          const ob = observability;
          if (!ob) return null;
          // 초록(ok)일 때는 아무것도 그리지 않습니다.
          //
          // 이 배너는 「이 어르신을 급식 기록으로 볼 수 있는가」에 답하려고 붙였습니다. 그런데
          // 볼 수 있는 분에게는 할 말이 없습니다 — "보고 있습니다"는 화면에 이미 등급과 달력이
          // 있으니 아무것도 보태지 않고, 상세 화면 맨 위 제일 좋은 자리를 차지합니다.
          // 말이 필요한 쪽은 **못 보는 분**(⚪)과 **늦게 잡히는 분**(🟡)입니다. 그때만 뜹니다.
          //
          // judged(= ob.canJudge) 는 그대로 씁니다. 아래 숫자 칸을 「—」로 가리는 판단은
          // 배너를 그리느냐와 별개입니다.
          if (ob.tone === "ok") return null;
          // 위에서 ok 를 걸렀으니 여기 남는 것은 🟡(늦게 잡힘)과 ⚪(못 봄) 둘뿐입니다.
          const tone =
            ob.tone === "warn"
              ? "border-amber-300 bg-amber-50/70"
              : "border-stone-400 bg-stone-100";
          const dot = ob.tone === "warn" ? "🟡" : "⚪";
          return (
            <div className={`mt-4 rounded-xl border-2 px-4 py-3 ${tone}`}>
              <div className="flex items-start gap-2.5">
                <span className="mt-[1px] shrink-0 text-base leading-none">{dot}</span>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-foreground">{ob.headline}</div>
                  {ob.detail && (
                    <div className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                      {ob.detail}
                    </div>
                  )}
                  {ob.next && (
                    <div className="mt-1.5 text-[13px] font-medium leading-relaxed text-foreground/80">
                      → {ob.next}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* AI 종합 분석 — 이 화면에서 가장 먼저, 가장 크게 봐야 하는 내용입니다.
            출결 패턴과 외부변수를 합쳐 "왜 이 등급인지"를 설명하는 자리라
            아래 달력보다 위에 두고 폭을 전부 씁니다. */}
        <Card className="mt-6 overflow-hidden p-0">
          <div className="border-l-4 border-l-primary">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-primary/[0.04] px-6 py-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Sparkles className="h-4.5 w-4.5" />
                </span>
                {/* 제목을 사실대로 답니다.
                    이 자리는 오래 "AI 종합 분석"이라고 적혀 있었지만, 실제로 보여준 것은
                    로직이 만든 템플릿 문장이었습니다. AI 가 붙었을 때만 AI라고 불러야
                    합니다 — 아니면 담당자가 "AI가 그랬다"고 믿고 근거를 못 따집니다. */}
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold tracking-tight">
                      {resident.aiSummary ? "위기 판단 · AI 설명" : "위기 판단"}
                    </h2>
                    {/* 안심 처리 중이면 「정상」이라고 단언하지 않습니다.
                        가린 것과 괜찮은 것은 다릅니다 — 연속결석 52일에 「정상」이
                        붙어 있고 바로 아래 AI가 연락하라고 하면 둘 다 못 믿습니다. */}
                    {snoozed ? (
                      <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                        😌 안심 처리 중
                      </span>
                    ) : (
                      <RiskBadge level={assessment.levelBeforeSnooze ?? assessment.level} />
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    등급은 출결 패턴으로 정합니다
                    {resident.aiSummary ? " · 설명은 AI가 씁니다" : ""}
                  </p>
                </div>
              </div>
            </div>

            <div className="px-6 py-5">
              {/* ★ 판정을 멈춘 분께는 **숫자를 0으로 채우지 않습니다.**
                  보류·종료·관측불가면 판정 함수가 0을 담아 돌려주는데, 그걸 그대로 찍으니
                  「평소 출석률 0%」가 떴습니다. 바로 아래 AI 문장은 같은 분을 두고
                  "평소 주 2회 정도 다니시던 어르신"이라고 적고 있었습니다. 한 화면에서
                  0%와 주 2회가 동시에 보이면 담당자는 어느 쪽도 못 믿습니다.
                  판정하지 않은 것은 「—」로 적고, 왜인지는 위 배너가 이미 말합니다. */}
              {/* 판단의 핵심 숫자를 문장에서 꺼내 먼저 보여줍니다. */}
              <dl className="mb-5 grid grid-cols-2 gap-x-6 gap-y-4 border-b pb-5 sm:grid-cols-3">
                {/* 「평소」와 「최근」을 **두 칸으로 갈라** 놓습니다.
                    한 이름에 두 값이 붙어 있었습니다 — 이 칸은 오늘 기준 60일 창인데
                    「평소」라고 적혀 있었고, 대시보드 한 줄의 "주 N회쯤 오시던 분"은
                    마지막 방문일 기준 창이었습니다. 그래서 목록에서 「거의 매일
                    오시던 분」을 보고 눌러 들어오면 여기 28%가 떠 있었습니다. */}
                <div>
                  <dt className="text-xs text-muted-foreground">
                    평소 출석률 (마지막 방문일까지 {BASELINE_DAYS}일)
                  </dt>
                  <dd className="mt-1 text-xl font-bold tabular-nums">
                    {judged ? `${assessment.habitRate}%` : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">최근 {BASELINE_DAYS}일 출석률</dt>
                  <dd className="mt-1 text-xl font-bold tabular-nums">
                    {judged ? `${assessment.baselineRate}%` : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">최근 30일</dt>
                  <dd
                    className={`mt-1 text-xl font-bold tabular-nums ${
                      assessment.rateDeviation >= 15 ? "text-red-600" : "text-foreground"
                    }`}
                  >
                    {judged ? `${assessment.recentRate}%` : "—"}
                    {judged && assessment.rateDeviation >= 15 && (
                      <span className="ml-1.5 text-xs font-medium">
                        ▼{assessment.rateDeviation}%p
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  {/* 「연속결석 1일」이 달력으로는 석 달일 수 있습니다.
                      휴관·밀키트 기간은 오실 기회가 없던 날이라 세지 않는데, 라벨에
                      그 말이 없으면 담당자가 달력과 맞춰보고 틀렸다고 읽습니다. */}
                  <dt className="text-xs text-muted-foreground">연속결석(운영일)</dt>
                  <dd
                    className={`mt-1 text-xl font-bold tabular-nums ${
                      assessment.consecutiveAbsence > 0 ? "text-red-600" : "text-foreground"
                    }`}
                  >
                    {assessment.consecutiveAbsence > 0
                      ? `${assessment.consecutiveAbsence}일`
                      : "없음"}
                  </dd>
                </div>
              </dl>

              {/* AI 설명이 있으면 그것을 먼저, 크게 보여줍니다.
                  대시보드에서 "AI 설명 붙이기"를 누르면 긴급·위기 어르신에게 붙습니다.
                  여기서 따로 부르지 않습니다 — 화면을 열 때마다 돈이 나가면 아무도 마음
                  편히 못 엽니다. 이미 만들어 둔 문장을 그대로 씁니다(추가 비용 없음). */}
              {resident.aiSummary ? (
                <>
                  <div className="max-w-4xl rounded-lg border border-rose-200 bg-rose-50/60 px-4 py-3">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-[11px] font-bold text-rose-700">AI 설명</span>
                      {resident.aiSummaryAt && (
                        <span className="text-[10px] text-rose-900/50">
                          {resident.aiSummaryAt} 기준
                        </span>
                      )}
                    </div>
                    <p className="text-[15px] leading-[1.85] text-rose-950">{resident.aiSummary}</p>
                  </div>
                  <details className="mt-3 max-w-4xl">
                    <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground hover:text-foreground">
                      로직이 계산한 근거 보기 ▾
                    </summary>
                    <p className="mt-2 text-sm leading-[1.8] text-muted-foreground">
                      {assessment.narrative}
                    </p>
                  </details>
                </>
              ) : (
                <>
                  <p className="max-w-4xl text-[15px] leading-[1.85] text-foreground">
                    {assessment.narrative}
                  </p>
                  {/* 왜 AI 설명이 없는지, 어떻게 붙이는지 적어 둡니다. 빈 자리만 있으면
                      기능이 없는 줄 압니다. */}
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    긴급·위기 어르신은 대시보드에서{" "}
                    <b className="text-foreground">AI 설명 붙이기</b>를 누르면 여기에도 AI가 쓴
                    설명이 붙습니다.
                  </p>
                </>
              )}

              <div className="mt-5 flex flex-wrap gap-1.5">
                {assessment.reasons.map((reason, i) => (
                  <span
                    key={i}
                    className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-[11px] text-muted-foreground"
                  >
                    {reason}
                  </span>
                ))}
              </div>

              <div className="mt-6 max-w-md">
                <div className="mb-2 text-xs text-muted-foreground">{asMonth}월 출석 vs 결석</div>
                <MonthAttendanceBar month={selectedMonthStat} />
              </div>
            </div>
          </div>
        </Card>

        {/* 개입 이력 — AI가 왜 이 등급으로 봤는지(위) 읽은 다음, 그래서 그동안 무엇을 했는지를
            바로 이어서 봅니다. 지금은 정상이어도 과거에 개입했던 기록이 있으면 판단이 달라지므로
            대시보드 관리군에 올라와 있지 않은 어르신도 여기서 전체 이력을 볼 수 있게 둡니다. */}
        <div className="mt-6 flex justify-end">
          <Button size="sm" onClick={() => setFollowupOpen(true)}>
            <PhoneCall className="mr-1.5 h-4 w-4" />
            확인 기록 남기기 · 고치기
          </Button>
        </div>
        <FollowupHistoryCard resident={resident} />

        <FollowupDialog
          target={followupOpen && assessment ? { resident, assessment } : null}
          onClose={() => setFollowupOpen(false)}
          checkedAt={recordDateFor(asOfStr)}
          dataAsOf={DATA_END_STR}
          canRecord={!!session}
        />

        {/* 캘린더 히트맵 */}
        <Card className="mt-6 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              출석 달력{" "}
              <span className="font-normal text-muted-foreground">
                ({showAllMonths ? "첫 기록부터 전체" : "최근 6개월"})
              </span>
            </h2>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {Object.entries(statusStyles).map(([k, v]) => (
                <div key={k} className="flex items-center gap-1.5">
                  <span className={`h-3 w-3 rounded ${v.bg}`} /> {v.label}
                </div>
              ))}
            </div>
          </div>
          <TooltipProvider delayDuration={100}>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {(showAllMonths ? calendarMonths : calendarMonths.slice(-6)).map((m) => {
                const firstWeekday = new Date(m.year, m.month - 1, 1).getDay();
                const blanks = Array.from({ length: firstWeekday });
                return (
                  <div
                    key={`${m.year}-${m.month}`}
                    className="rounded-md border border-stone-200 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between text-sm font-medium text-foreground">
                      <span>{m.label}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {/* 셀 수 있는 날이 하나도 없는 달은 "0%"가 아니라 "판단 제외"입니다.
                            0%라고 쓰면 한 번도 안 오신 것처럼 읽힙니다. */}
                        {m.totalCount > 0
                          ? `${m.presentCount}/${m.totalCount} · ${m.rate}%`
                          : "판단 제외"}
                      </span>
                    </div>
                    <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
                      {["일", "월", "화", "수", "목", "금", "토"].map((d) => (
                        <div key={d}>{d}</div>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                      {blanks.map((_, i) => (
                        <div key={`b-${i}`} className="aspect-square" />
                      ))}
                      {m.days.map((cell) => (
                        <UITooltip key={cell.day}>
                          <TooltipTrigger asChild>
                            <div
                              className={`flex aspect-square items-center justify-center rounded text-[10px] font-medium text-white/90 ${statusStyles[cell.status].bg} ${
                                cell.status === "none" ? "text-stone-400" : ""
                              }`}
                            >
                              {cell.day}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <div className="text-xs">
                              {m.year}-{String(m.month).padStart(2, "0")}-
                              {String(cell.day).padStart(2, "0")} ·{" "}
                              {statusStyles[cell.status].label}
                            </div>
                          </TooltipContent>
                        </UITooltip>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </TooltipProvider>
          {calendarMonths.length > 6 && (
            <div className="mt-4 text-center">
              <Button variant="outline" size="sm" onClick={() => setShowAllMonths((v) => !v)}>
                {showAllMonths
                  ? "접기 (최근 6개월만)"
                  : `이전 기록 펼치기 (${calendarMonths.length - 6}개월 더 · 2025년 포함)`}
              </Button>
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}

function ResidentNotFound({ id }: { id: string }) {
  return (
    <div className="min-h-screen bg-stone-50">
      <NavBar />
      <main className="mx-auto max-w-lg px-6 py-24 text-center">
        <Card className="p-8">
          <h1 className="text-lg font-semibold">찾을 수 없는 어르신입니다</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            <b className="font-medium text-foreground">{id.toUpperCase()}</b> 번호로 등록된 어르신이
            없습니다. 퇴소 처리되었거나 삭제된 기록일 수 있습니다.
          </p>
          <Button variant="outline" asChild className="mt-5">
            <Link to="/dashboard">대시보드로</Link>
          </Button>
        </Card>
      </main>
    </div>
  );
}

function FollowupHistoryCard({ resident }: { resident: Resident }) {
  const history = getFollowupsForResident(resident.id);
  const neededCount = history.filter((f) => f.outcome === "needed").length;

  return (
    <Card className="mt-6 p-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">확인 기록</h2>
        {history.length > 0 && (
          <span className="text-xs text-muted-foreground">
            총 {history.length}회 확인 · 개입 필요 {neededCount}회
          </span>
        )}
      </div>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          아직 확인 기록이 없습니다. 위 「확인 기록 남기기」를 누르면 바로 적을 수 있습니다.
        </p>
      ) : (
        <ol className="space-y-2">
          {history.map((f, i) => {
            const ordinal = history.length - i; // 최신이 위이므로 뒤에서부터 세어 n차를 매깁니다
            const needed = f.outcome === "needed";
            const unreachable = f.outcome === "no_answer" || f.resultKind === "확인불가";
            const closed = isClosedFollowup(f);
            return (
              <li
                key={f.id}
                className={`rounded-md border p-3 ${
                  needed ? "border-red-200 bg-red-50/60" : "border-emerald-200 bg-emerald-50/60"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-foreground">{ordinal}차</span>
                  <span className="tabular-nums text-muted-foreground">{f.checkedAt}</span>
                  <span className="text-muted-foreground">{f.staff}</span>
                  <span
                    // ★ 부재중과 종결이 초록 「지금은 괜찮으심」으로 떴습니다.
                    //   needed 가 아니면 전부 else 로 떨어졌기 때문입니다 —
                    //   돌아가신 분도, 세 번 걸어 못 만난 분도 초록이었습니다.
                    //   같은 화면의 확인 기록 목록은 같은 건을 「부재중」이라 적으니
                    //   한 어르신 화면 안에서 두 곳이 정반대를 말했습니다.
                    //   전화 걸기 직전에 담당자가 여는 화면입니다.
                    className={`rounded-full border bg-white px-2 py-0.5 text-[11px] font-medium ${
                      closed
                        ? "border-stone-300 text-stone-600"
                        : unreachable
                          ? "border-amber-300 text-amber-800"
                          : needed
                            ? "border-red-200 text-red-700"
                            : "border-emerald-200 text-emerald-700"
                    }`}
                  >
                    {closed
                      ? "사례 관리 종료"
                      : unreachable
                        ? "부재중 — 아직 확인 못 함"
                        : needed
                          ? "도움이 더 필요"
                          : "지금은 괜찮으심"}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-foreground">
                  {f.note || (
                    <span className="text-muted-foreground">사유가 기록되지 않았습니다.</span>
                  )}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

// 출석/결석 막대.
//
// 예전에는 `resident.attendance`를 직접 훑어 `else absent++` 로 셌는데, 자료에는 **오신
// 날만** 들어 있어 결석이 언제나 0이었습니다(막대가 늘 "출석 100%"). 달력이 이미 운영일
// 기준으로 세어 둔 값을 그대로 씁니다 — 두 군데서 따로 세면 또 어긋납니다.
function MonthAttendanceBar({ month }: { month?: ResidentCalendarMonth }) {
  const present = month?.presentCount ?? 0;
  const absent = (month?.totalCount ?? 0) - present;
  const total = month?.totalCount || 1;
  const items = [
    { label: "출석", value: present, color: "bg-emerald-400" },
    { label: "결석", value: absent, color: "bg-red-400" },
  ];
  return (
    <div className="space-y-2">
      {items.map((b) => (
        <div key={b.label}>
          <div className="flex justify-between text-xs">
            <span>{b.label}</span>
            <span className="font-medium">{b.value}일</span>
          </div>
          <div className="mt-1 h-2 w-full rounded bg-stone-100">
            <div
              className={`h-2 rounded ${b.color}`}
              style={{ width: `${(b.value / total) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
