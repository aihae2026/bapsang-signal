import {
  ResidentName,
  residentLabel,
  residentSubtitle,
  MealTierMark,
} from "@/components/ResidentName";
import { RiskTrend } from "@/components/RiskTrend";
import { runAiAssessments, fetchAiSpend } from "@/lib/ai-assessment";
import { Fragment, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowUpRight, ChevronLeft, ChevronRight } from "lucide-react";
import { NavBar } from "@/components/NavBar";
import { HeartbeatWatermark } from "@/components/HeartbeatWatermark";
import { BapsangMark } from "@/components/BapsangMark";
import { ResidentAvatar } from "@/components/ResidentAvatar";
import { RiskBadge } from "@/components/RiskBadge";
import { FollowupDialog, FollowupControl } from "@/components/FollowupDialog";
import { useSession } from "@/lib/use-session";
import {
  BASELINE_DAYS,
  DATA_END_STR,
  DATA_START_STR,
  TODAY_DATE,
  formatDateWithWeekday,
  getAiRiskAssessment,
  getCurrentRisk,
  getDayDetail,
  getActiveResidents,
  getBlockedCount,
  getRegisteredCountAsOf,
  getRosterTotal,
  EMPTY_WORKLIST,
  describeVisitFrequency,
  getInputGuardStatus,
  getOutputGuardStatus,
  getDataFreshness,
  getRepeatedDowngrades,
  getResumeOverdue,
  getVisitNeeded,
  OPERATING_DAYS,
  getRiskWorklist,
  setResidentAiSummary,
  RESULT_KIND_META,
  getFollowupsForResident,
  getLatestFollowup,
  recheckDueDate,
  recordDateFor,
  getMemberState,
  UNREACHABLE_ESCALATE,
  isClosedFollowup,
  isRestingOn,
  followupCutoff,
  getResidentById,
  FOLLOWUPS,
  getMonthlyStats,
  useDataVersion,
  type AiRiskAssessment,
  type Followup,
  type Resident,
  type WorklistEntry,
  type RiskLevel,
} from "@/lib/attendance-engine";

const SEVERITY_ORDER: Record<RiskLevel, number> = {
  crisis: 0,
  caution: 1,
  concern: 2,
  normal: 3,
  // 판단하지 않은 분은 맨 아래. 위에서부터 읽는 목록이라, 판단한 분이 먼저여야 합니다.
  unknown: 4,
};

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

/**
 * 그 달 진행 상황을 한 줄로.
 *
 * 「연락 N명 · 남은 M명」이라고만 적으면, 전화를 다 돌리고도 「남은 1명」이 남습니다 —
 * 그 한 분은 안 건 분이 아니라 **걸었는데 안 받으신 분**이기 때문입니다. 담당자가
 * "다 했는데 왜?" 하고 목록을 다시 뒤지게 됩니다.
 *
 * 그래서 셋을 따로 적되, **0인 것은 적지 않습니다.** 늘 세 칸을 채우면 글이 길어져
 * 정작 급한 숫자가 안 보입니다.
 */
function describeProgress(p: {
  total: number;
  done: number;
  noAnswer: number;
  never: number;
}): string | undefined {
  if (p.total === 0) return undefined;
  const parts: string[] = [];
  if (p.done > 0) parts.push(`확인 ${p.done}명`);
  if (p.noAnswer > 0) parts.push(`부재중 ${p.noAnswer}명`);
  if (p.never > 0) parts.push(`아직 ${p.never}명`);
  return parts.join(" · ");
}

type KpiListKind = "today" | "crisis" | "caution" | "avgAttendance";

interface KpiEntry {
  resident: Resident;
  rightLabel: string;
  /** 등급 배지. 출석 횟수 목록처럼 등급을 붙이면 안 되는 곳에서는 생략합니다. */
  badge?: RiskLevel;
}

/**
 * 그 달에 이 등급으로 **감지되어 이미 손을 쓴** 분들.
 *
 * ★ 왜 따로 필요한가 — 총원이 줄어들면 그 달에 무슨 일이 있었는지 알 수 없습니다.
 *
 *   확인 결과가 「일시적 사정」·「이용감소」·「일자리 참여」면 status 가 **보류**라
 *   판정이 멈추고, 「사망」·「이사전출」·「요양원입소」면 **종료**입니다. 둘 다
 *   classifyAttendance 맨 앞의 `if (state.status !== "감시중") return notEnough()`
 *   에 걸려 등급이 안 매겨집니다. 그 결과 **「9월 긴급 인원」이 전화를 돌릴수록
 *   줄어들었습니다** — 19명을 확인하고 나니 화면에는 4명만 남았습니다.
 *
 *   의도한 동작이지만(오늘 전화할 목록에서 빼는 것), 카드 이름은 「9월 긴급 인원」
 *   입니다. 그 달에 몇 분이 위태로웠고 몇 분을 확인했는지는 기관이 남겨야 할 기록인데,
 *   확인할수록 없던 일이 되어 버립니다. 가린 것과 없던 것은 다릅니다.
 *
 *   근거는 이미 자료에 있습니다 — 확인 기록마다 **그때의 등급(riskLevel)** 이 함께
 *   저장돼 있습니다. 판정을 다시 돌릴 필요 없이, 그 달 기록에서 읽어오면 됩니다.
 *
 * 한 분이 그 달에 여러 번이면 **가장 나중 기록** 하나만 둡니다(사람 수를 세는 자리).
 */
function getMonthHandled(
  year: number,
  month: number,
  level: "crisis" | "caution",
  /**
   * 이 달 **이후**에 적은 기록도 함께 셀지.
   *
   * ★ 10월 1일에 출근하면 화면은 아직 「9월」을 보고 있습니다(자료가 9/17 까지니까).
   *   그런데 그날 전화해서 남긴 기록의 날짜는 **10-01** 입니다. 달 접두어로만
   *   거르면 그 기록이 9월 어디에도 안 잡혀, 확인할수록 「9월 긴급 인원」이
   *   줄어듭니다 — 이 함수를 만든 이유가 그대로 무너집니다.
   *   보고 있는 달이 가장 최근 달이면, 그 이후 기록도 이 달 몫으로 셉니다.
   */
  alsoAfter?: string,
): Map<string, Followup> {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const byId = new Map<string, Followup>();
  for (const f of FOLLOWUPS) {
    const inMonth = f.checkedAt.startsWith(prefix) || (!!alsoAfter && f.checkedAt > alsoAfter);
    if (f.riskLevel !== level || !inMonth) continue;
    const prev = byId.get(f.residentId);
    if (!prev || f.checkedAt > prev.checkedAt || (f.checkedAt === prev.checkedAt && f.id > prev.id))
      byId.set(f.residentId, f);
  }
  return byId;
}

function getMonthRiskEntries(year: number, month: number, level: "crisis" | "caution"): KpiEntry[] {
  const monthEnd = new Date(year, month, 0);
  const monthEndStr = `${year}-${String(month).padStart(2, "0")}-${String(monthEnd.getDate()).padStart(2, "0")}`;

  /** 그 어르신이 지금 어디까지 왔는지. 숫자가 아니라 이 말이 담당자가 찾는 것입니다. */
  const describe = (id: string, fallback: string) => {
    const f = getLatestFollowup(id, monthEndStr);
    if (!f) return { rank: 1, label: `아직 연락 안 함 · ${fallback}` };
    const what = f.resultKind
      ? (RESULT_KIND_META[f.resultKind]?.label ?? f.resultKind)
      : f.outcome === "no_answer"
        ? "부재중"
        : f.outcome === "needed"
          ? "도움이 더 필요"
          : "확인함";
    const unreachable = f.outcome === "no_answer" || f.resultKind === "확인불가";
    return { rank: unreachable ? 0 : 2, label: `${f.checkedAt.slice(5)} · ${what}` };
  };

  const rows: (KpiEntry & { rank: number })[] = [];
  const seen = new Set<string>();
  for (const r of getActiveResidents()) {
    const risk = getCurrentRisk(r, monthEnd);
    if (risk.level !== level) continue;
    seen.add(r.id);
    const d = describe(r.id, `${risk.rate}%`);
    rows.push({ resident: r, rightLabel: d.label, badge: level, rank: d.rank });
  }
  // 확인을 마쳐 판정에서 빠진 분을 되살려 붙입니다.
  for (const id of getMonthHandled(year, month, level).keys()) {
    if (seen.has(id)) continue;
    const r = getResidentById(id);
    if (!r) continue;
    const d = describe(id, "—");
    rows.push({ resident: r, rightLabel: d.label, badge: level, rank: d.rank });
  }

  // ★ **손이 더 가야 하는 분이 맨 위로.**
  //
  //   예전에는 판정에 남아 있는 분을 먼저, 확인을 마친 분을 뒤로 놓았습니다. 그래서
  //   「부재중 1명」이라고 적힌 그 한 분이 열다섯 줄 **맨 아래**에 묻혔습니다. 담당자는
  //   카드에서 숫자를 보고 명단을 열었는데, 정작 그 사람을 찾으려면 끝까지 훑어야 했습니다.
  //
  //   0 부재중(다시 걸어야 함) · 1 아직 연락 안 함 · 2 확인 끝
  return rows
    .sort((a, b) => a.rank - b.rank)
    .map(({ resident, rightLabel, badge }) => ({ resident, rightLabel, badge }));
}

// 선택한 달 안에서 실제 운영 기록이 있는 마지막 날을 찾습니다. 주말·휴관일에는 기록이
// 없으므로 거슬러 올라가며 찾고, 지난달을 선택했으면 그 달의 마지막 운영일이 기준이 됩니다.
function getLastOperatingDateInMonth(year: number, month: number): string | null {
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let day = daysInMonth; day >= 1; day--) {
    const ds = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (ds > DATA_END_STR) continue;
    if (ds < DATA_START_STR) break;
    if (getDayDetail(ds).hasData) return ds;
  }
  return null;
}

// 직전 운영일 — "어제와 비교해 무엇이 달라졌나"를 계산하는 기준일입니다.
function getPreviousOperatingDate(fromDateStr: string): string | null {
  const d = new Date(fromDateStr);
  d.setDate(d.getDate() - 1);
  for (let i = 0; i < 21; i++) {
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (ds < DATA_START_STR) return null;
    if (getDayDetail(ds).hasData) return ds;
    d.setDate(d.getDate() - 1);
  }
  return null;
}

function ResidentListDialog({
  open,
  onOpenChange,
  title,
  entries,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  entries: KpiEntry[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {title} ({entries.length}명)
          </DialogTitle>
        </DialogHeader>
        <ul className="divide-y">
          {entries.map(({ resident: r, rightLabel, badge }) => (
            <li key={r.id} className="py-2.5">
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

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "위기 신호 대시보드 | 밥상위의 신호" },
      {
        name: "description",
        content: "식사 출석 패턴에서 어르신 위기 신호를 조기에 감지하는 실무자용 대시보드.",
      },
      { property: "og:title", content: "위기 신호 대시보드 | 밥상위의 신호" },
      { property: "og:description", content: "실무자용 위기 조기발견 대시보드." },
    ],
  }),
  component: DashboardPage,
});

function SummaryCard({
  label,
  value,
  note,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  /** 숫자 아래 작은 기준 설명(예: "등록 396명 중"). 없으면 표시하지 않습니다. */
  note?: string;
  tone: "safe" | "caution" | "danger" | "info";
  onClick?: () => void;
}) {
  const toneStyles = {
    safe: "text-emerald-600",
    caution: "text-amber-600",
    danger: "text-red-600",
    info: "text-blue-600",
  } as const;
  return (
    <Card
      className={`p-5 ${onClick ? "cursor-pointer transition-shadow hover:shadow-md" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="text-xs text-muted-foreground">
        {label}
        {onClick && <span className="ml-1 text-muted-foreground/60">명단 보기 &rsaquo;</span>}
      </div>
      <div className={`mt-2 text-3xl font-bold ${toneStyles[tone]}`}>{value}</div>
      {/* 「연락 4명 · 남은 1명」은 큰 숫자만큼 중요한 정보입니다 — 오늘 할 일이 얼마나
          남았는지가 여기 있습니다. 회색 11px 로는 안 읽혔습니다. 큰 숫자보다는 작게 두되
          (그래야 위아래 위계가 남습니다) 본문 색·굵은 글씨로 올립니다. */}
      {note && <div className="mt-1 text-sm font-semibold text-foreground/80">{note}</div>}
    </Card>
  );
}

const today = TODAY_DATE;

// 조기개입 줄의 한 줄 근거. 요청서 원칙에 따라 숫자 점수·확률은 표시하지 않습니다.
// 평소 빈도(대략)와 며칠째인지만 담백하게 적습니다.
function worklistReason(e: WorklistEntry): string {
  const freq = describeVisitFrequency(e.habitRate);
  if (e.signal === "chronic") return `${freq} 오시던 분인데 최근 들어 눈에 띄게 줄고 있습니다`;
  return `${freq} 오시던 분인데 ${e.consecutiveAbsence}일째 안 나오십니다`;
}

function worklistKeywordClass(kw: string): string {
  if (kw === "건강 이상" || kw === "의료 필요" || kw === "감정 저하")
    return "rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-medium text-rose-700";
  if (kw === "긍정적 변화")
    return "rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700";
  if (kw === "급격한 이탈")
    return "rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800";
  return "rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600";
}

/**
 * 「연락 드린 분」에 남겨 두는 기간.
 *
 * 한 달이면 "이번 달에 누구에게 연락했나"가 다 보입니다. 더 길게 두면 지난 계절의 기록이
 * 쌓여 오늘 한 일이 안 보이고, 더 짧게 두면 지난주에 적은 것이 사라집니다.
 */
const CONTACTED_WINDOW_DAYS = 30;

// 조기개입 목록의 한 줄. "지금 먼저 연락할 분"과 옛 "관리군"을 하나로 합친 뒤로, 이 줄이
// 우선순위(며칠째·근거)와 관리 기능(등급·NEW·3개월 추이·확인 기록)을 함께 담습니다.
function WorklistRow({
  entry: e,
  index,
  assessment,
  isNew,
  followup,
  followupCount,
  unreachableStreak,
  asOfStr,
  canRecord,
  onFollowup,
}: {
  entry: WorklistEntry;
  index?: number;
  assessment?: AiRiskAssessment;
  isNew: boolean;
  followup: Followup | null;
  followupCount: number;
  /** 연달아 연락이 안 된 횟수. 중간에 한 번이라도 통화가 됐으면 거기서 끊깁니다. */
  unreachableStreak: number;
  /** 이 화면이 보고 있는 기준일. 「안심 기한이 지났나」를 여기에 견줍니다. */
  asOfStr: string;
  canRecord: boolean;
  onFollowup: () => void;
}) {
  // ★ **왜 이 줄이 여기 있는지**를 이름 옆에 답니다.
  //
  //   「연락할 분」에는 세 종류가 섞여 있습니다 — 아직 한 번도 안 건 분, 걸었는데 안
  //   받으셔서 다시 걸어야 하는 분, 안심 기한이 지나 다시 볼 때가 된 분. 순서는 그렇게
  //   세워 두면서 **화면에는 그 이유가 안 보였습니다.** 확인 기록 배지는 줄 맨 아래
  //   오른쪽 구석에 11px 로 있어서, 위에서부터 전화를 돌리는 눈에는 안 들어옵니다.
  //
  //   그래서 담당자가 다시 올라온 분을 보고 "이분이 아까 안 받으신 분인가, 새로 뜬
  //   위기인가"를 알 수 없었습니다. 알려면 한 줄씩 눌러 봐야 합니다.
  const unreachable = followup?.outcome === "no_answer" || followup?.resultKind === "확인불가";
  // ★ 「다시 볼 때가 됨」은 **안심 기한이 실제로 지났을 때만** 적습니다.
  //
  //   예전에는 `확인 기록이 있고 부재중이 아니면` 전부 그렇게 적었습니다. 그래서
  //   그제(9/15) 연락드려 「도움이 더 필요」로 적어 둔 분이, 오늘(9/17) 「⏰ 다시 볼
  //   때가 됨」으로 떴습니다. 이틀 전에 통화했는데요.
  //
  //   그분이 목록에 남아 있는 이유는 기한이 지나서가 아니라 **애초에 기한을 안 둬서**
  //   입니다(계속 지켜보기로 한 것). 둘은 담당자가 할 일이 다릅니다 —
  //     기한이 지남  → 약속한 때가 됐으니 다시 연락
  //     기한이 없음  → 이미 알고 지켜보는 중. 오늘 또 걸 필요는 없습니다.
  const snoozeExpired =
    !!followup?.snoozeUntil && !isClosedFollowup(followup) && followup.snoozeUntil < asOfStr;

  const justChecked = !!followup && !unreachable && !snoozeExpired;
  return (
    <li className="rounded-md border border-rose-100 bg-white px-3 py-2">
      {/* ★ flex-wrap 이 없으면 휴대폰에서 이 줄이 무너집니다. 한 줄에 순번·이름·등급·
          부재중 칩·3개월 추이·「N일째」까지 여섯 가지가 들어가는데, 231px 안에서
          모두 같이 눌려 「부재중 2회째」 칩이 한 글자씩 세로로 쌓여 높이 204px가
          됐습니다. 줄바꿈을 허용하면 각자 제 폭을 갖고 아랫줄로 내려갑니다.
          넓은 화면에서는 한 줄에 다 들어가 줄바꿈이 일어나지 않으므로 그대로입니다. */}
      <div className="flex flex-wrap items-center gap-2">
        {index !== undefined && <span className="text-xs font-bold text-rose-400">{index}</span>}
        <Link
          to="/resident/$id"
          params={{ id: e.resident.id }}
          className="text-sm font-semibold text-foreground hover:underline"
        >
          <ResidentName resident={e.resident} />
        </Link>
        <MealTierMark resident={e.resident} />
        {/* 사유를 확인해 기한을 건 분은 등급이 normal 로 바뀝니다(목록에서 빼려고).
            그런데 그분들도 이 목록에 남기기로 하면서, 「긴급」이었던 분 옆에 초록색
            「정상」 배지가 붙었습니다. 구분선은 "이미 연락드린 분"이라 하고 배지는
            "정상"이라 하니, 무엇을 믿어야 할지 알 수 없습니다.
            가려지기 전 등급을 그대로 보여줍니다 — 가린 것과 괜찮아진 것은 다릅니다. */}
        {assessment && <RiskBadge level={e.levelBeforeSnooze ?? assessment.level} />}
        {isNew && (
          <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
            NEW
          </span>
        )}
        {unreachable && unreachableStreak >= UNREACHABLE_ESCALATE && (
          <span
            className="rounded-full border border-red-500 bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white"
            title={`${unreachableStreak}회 연달아 연락이 닿지 않았습니다 — 방문으로 확인해야 하는 단계입니다`}
          >
            🚪 {unreachableStreak}회 불통 · 방문 확인
          </span>
        )}
        {unreachable && unreachableStreak < UNREACHABLE_ESCALATE && (
          <span
            className="rounded-full border border-amber-400 bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900"
            title={`${followup?.checkedAt} 에 연락드렸으나 받지 않으셨습니다 (연달아 ${unreachableStreak}회)`}
          >
            {/* ★ 전체 확인 기록 수가 아니라 **연달아 안 된 횟수**입니다.
                예전에는 followupCount(전체)를 찍었습니다. 지난달에 통화가 잘 됐던
                기록까지 세어서, 오늘 처음 안 받으신 분이 「부재중 4회째」로 보였습니다.
                담당자가 알고 싶은 것은 "이번에 몇 번 헛걸음했나"입니다. */}
            📵 부재중 {unreachableStreak}회째 · 다시 연락
          </span>
        )}
        {snoozeExpired && (
          <span
            className="rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800"
            title={`${followup?.snoozeUntil}까지 안심 처리했는데 그 날이 지나도 안 나오십니다`}
          >
            ⏰ {followup?.snoozeUntil?.slice(5)} 기한 지남
          </span>
        )}
        {/* ★ **왜 아직 여기 있는지**를 배지가 말해야 합니다.
            예전에는 「✔ 09-18 확인함」이라고만 적었습니다. 그런데 「도움이 더 필요」로
            적으신 분은 기본 7일 뒤에 다시 보도록 목록에 남습니다 — 의도한 동작인데,
            화면은 「확인함」이라고만 하니 "확인했는데 왜 계속 떠 있냐"가 됩니다.
            무엇으로 적으셨는지와 **언제 다시 보는지**를 함께 적습니다. */}
        {justChecked &&
          (() => {
            const kind = followup?.resultKind
              ? (RESULT_KIND_META[followup.resultKind]?.label ?? followup.resultKind)
              : followup?.outcome === "needed"
                ? "도움이 더 필요"
                : "확인함";
            const due = followup ? recheckDueDate(followup) : null;
            return (
              <span
                className="rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-700"
                title={
                  due
                    ? `${followup?.checkedAt}에 「${kind}」로 적으셨습니다. ${due}까지 쉬고 그 다음 날 다시 올라옵니다.`
                    : `${followup?.checkedAt}에 확인하셨습니다.`
                }
              >
                {/* 「~까지」입니다. 그 날은 아직 쉬고 **다음 날** 돌아옵니다 —
                    화면 다른 곳(「사유를 확인한 분」의 언제까지 칸)과 같은 뜻으로 적습니다.
                    시뮬레이션에서 「09-25 다시 봄」이라 적어 두고 실제 복귀는 09-26 인
                    어긋남을 잡았습니다. */}
                ✔ {followup?.checkedAt.slice(5)} {kind}
                {due ? ` · ~${due.slice(5)}까지` : ""}
              </span>
            );
          })()}
        <RiskTrend resident={e.resident} />
        <span className="ml-auto text-xs font-bold text-rose-700">{e.consecutiveAbsence}일째</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 pl-5">
        {e.keywords.map((kw) => (
          <span key={kw} className={worklistKeywordClass(kw)}>
            {kw}
          </span>
        ))}
        {e.lastDate && (
          <span className="text-[11px] text-muted-foreground">· 마지막 {e.lastDate.slice(5)}</span>
        )}
      </div>
      {/* 전화를 걸기 전에 담당자가 가장 먼저 읽는 한 줄입니다. 11px 회색으로 두면
          이름·등급 배지에 묻혀 그냥 지나칩니다. 본문 크기로 올리고 색도 진하게. */}
      <div className="mt-1 pl-5 text-sm leading-relaxed text-foreground/80">
        {worklistReason(e)}
      </div>
      {/* AI 설명은 접어 둡니다.
          한 줄 목록을 훑으며 전화를 돌리는 게 실제 업무인데, 다섯 줄짜리 설명이 사람마다
          펼쳐져 있으면 목록이 아니라 문서가 됩니다. 판단에 필요한 것(이름·등급·며칠째·
          한 줄 이유)은 위에 그대로 두고, 자세한 근거는 눌렀을 때만 폅니다. */}
      {e.resident.aiSummary && (
        <details className="group mt-1 ml-5">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-rose-700 hover:text-rose-900">
            판단 근거 보기 <span className="group-open:hidden">▾</span>
            <span className="hidden group-open:inline">▴</span>
          </summary>
          <div className="mt-1 rounded-md bg-rose-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-rose-900/90">
            <span className="font-semibold text-rose-700">AI</span> {e.resident.aiSummary}
            {/* 언제 쓴 글인지 붙입니다.
              AI 문장은 **만든 순간의 자료와 설정으로 쓴 글**이고 그대로 저장됩니다. 그 뒤로
              어르신이 다시 나오시거나 외부변수 스위치를 바꿔도 문장은 그대로입니다. 날짜가
              없으면 지난주 기준 문장을 오늘 판단으로 읽게 됩니다. */}
            {e.resident.aiSummaryAt && (
              <span className="ml-1.5 whitespace-nowrap text-[10px] text-rose-900/50">
                ({e.resident.aiSummaryAt.slice(5).replace("-", "/")} 기준)
              </span>
            )}
          </div>
        </details>
      )}
      <div className="mt-1.5 flex justify-end pl-5">
        <FollowupControl
          followup={followup}
          count={followupCount}
          canRecord={canRecord}
          onOpen={onFollowup}
        />
      </div>
    </li>
  );
}

// "연락 드린 분" 목록의 결과 배지. 마지막 확인 기록의 성격을 색으로 구분합니다.
function ContactedBadge({ followup }: { followup: Followup }) {
  const closed = followup.note.startsWith("[종결]");
  // 부재중은 「지금은 괜찮으심」이 아닙니다.
  //
  // 전화를 못 받으신 것은 **확인이 끝난 게 아닙니다.** 그런데 초록색 「지금은 괜찮으심」이
  // 붙어 있으면 훑어보는 눈에는 해결된 줄로 보입니다. 가장 걱정스러운 분이
  // 가장 안심되는 색을 달고 있던 셈입니다. 따로 이름을 주고 색도 노랗게 둡니다.
  const unreachable = followup.outcome === "no_answer" || followup.resultKind === "확인불가";
  const label = closed
    ? "종결"
    : unreachable
      ? "부재중"
      : followup.outcome === "needed"
        ? "도움이 더 필요"
        : followup.snoozeUntil
          ? "안심"
          : "지금은 괜찮으심";
  const cls = closed
    ? "border-stone-300 bg-stone-100 text-stone-600"
    : unreachable
      ? "border-amber-300 bg-amber-50 text-amber-800"
      : followup.outcome === "needed"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-emerald-200 bg-emerald-50 text-emerald-700";
  return (
    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

// 비용을 원화로 바꿔 보여줄 때 쓰는 환율.
//
// 정확한 환율이 필요한 자리가 아닙니다 — "이번 달에 얼마 썼나"를 가늠하는 용도라 어림수로
// 충분합니다. 실제 청구는 Anthropic 에서 달러로 이뤄지므로 괄호에 달러도 함께 적습니다.
const USD_TO_KRW = 1400;

/** 대시보드에서 마지막으로 고른 달. 상세 화면에 다녀와도 그 달을 그대로 보여주려고 둡니다. */
let rememberedMonthKey: string | null = null;

function DashboardPage() {
  // version은 자료·설정·외부변수 스위치가 바뀔 때마다 증가합니다. 아래 무거운 계산들의
  // useMemo 의존성으로 써서, 바뀌지 않았으면 396명 재계산을 건너뜁니다(리렌더 성능).
  const version = useDataVersion();
  const session = useSession();
  const navigate = useNavigate();
  const [listDialog, setListDialog] = useState<{ title: string; entries: KpiEntry[] } | null>(null);
  const [worklistPage, setWorklistPage] = useState(1); // 조기개입 목록 페이지(10명씩)
  // 「연락 드린 분」도 같은 방식으로 넘깁니다. 예전에는 한쪽만 스크롤이라 두 칸의 길이가
  // 안 맞았습니다 — 왼쪽은 길게 늘어나고 오른쪽은 아래가 잘린 채 빈 공간이 남았습니다.
  const [contactedPage, setContactedPage] = useState(1);
  const [followupTarget, setFollowupTarget] = useState<{
    resident: Resident;
    assessment: AiRiskAssessment;
  } | null>(null);

  // AI 판단(설명 문장) 실행 상태와 이번 달 비용.
  const [aiRunning, setAiRunning] = useState(false);
  // 진행 상황. 「쓰는 중…」만 떠 있으면 담당자는 멈춘 것인지 도는 것인지 알 수 없어
  // 새로고침을 누릅니다(그러면 돈만 쓰고 결과는 버려집니다). 몇 명째인지 보여줍니다.
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null);
  const [aiSpend, setAiSpend] = useState<{ spent: number; cap: number } | null>(null);
  useEffect(() => {
    void fetchAiSpend().then(setAiSpend);
  }, []);

  // 이 화면의 KPI·관리군·외부변수·대응 이력은 모두 "선택한 달" 기준입니다.
  // 여러 달을 한 번에 묶어 보는 일은 위험군 리포트에서 기간을 골라 합니다.
  const monthOptions = getTrendMonths();
  const thisMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  // 고른 달을 화면이 사라져도 기억합니다.
  //
  // 7월을 보다가 어르신 한 분을 눌러 상세로 들어갔다 돌아오면 9월로 되돌아가 있었습니다.
  // 대시보드 컴포넌트가 통째로 사라졌다 다시 만들어지면서 useState 가 초기값으로 돌아가기
  // 때문입니다. 지난 달 명단을 훑으며 한 분씩 눌러 보는 것이 이 화면의 기본 동작인데,
  // 한 분 볼 때마다 달을 다시 골라야 했습니다.
  //
  // 새로고침하면 이번 달로 돌아옵니다(모듈 변수라 페이지를 새로 열면 비워집니다).
  // 어제 보던 달이 오늘 그대로 떠 있는 것도 곤란하므로, 이 정도가 맞다고 봅니다.
  const [monthKey, setMonthKey] = useState(rememberedMonthKey ?? thisMonthKey);
  useEffect(() => {
    rememberedMonthKey = monthKey;
  }, [monthKey]);
  const [calYear, calMonth] = monthKey.split("-").map(Number);
  const monthIdx = monthOptions.findIndex((m) => m.year === calYear && m.month === calMonth);
  const toKey = (m: { year: number; month: number }) =>
    `${m.year}-${String(m.month).padStart(2, "0")}`;

  const activeResidents = useMemo(() => getActiveResidents(), [version]);

  // 선택한 달의 마지막 날을 기준으로 판단합니다.
  //
  // ★ 단, **자료가 있는 마지막 날을 넘지 않습니다.**
  //
  //   예전 주석은 "getAiRiskAssessment 내부에서 클램프되므로 미래로 계산되지 않는다"고
  //   적어 두었는데, 클램프하는 것은 그 함수 **하나뿐**이었습니다. assessAtStr 을 그대로
  //   받는 나머지(getResumeOverdue · getMemberState · getRiskWorklist · getVisitNeeded …)는
  //   전부 월말을 오늘로 알고 계산했습니다. 실제로 이런 화면이 나왔습니다 —
  //
  //     화면 머리말: 2026-09-15 (화) 기준
  //     📅 나오신다고 하신 날이 지났습니다 — 성○향 · 09-28 예정이었음
  //
  //   9월 28일은 아직 열흘 남았습니다. 비교 대상이 9월 30일이었을 뿐입니다. 담당자가
  //   달력을 보고 "아직 안 지났는데?" 하는 순간, 그 배너만이 아니라 목록 전체를
  //   안 믿게 됩니다.
  //
  //   화면이 「9월 15일 기준」이라고 적었으면 계산도 9월 15일로 해야 합니다.
  /**
   * 보고 있는 달의 **달력상** 마지막 날. assessAtStr 과 달리 자료 끝으로 자르지 않습니다.
   *
   * 「이번 달 안에 다시 볼 분인가」를 가르는 데 씁니다. 자료가 9/17까지만 있어도
   * 9/25에 다시 볼 분은 이번 달 할 일이 맞습니다.
   */
  const calMonthEndStr = useMemo(() => {
    const end = new Date(calYear, calMonth, 0);
    return `${calYear}-${String(calMonth).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
  }, [calYear, calMonth]);

  /**
   * 「이 달 이후에 적은 기록도 이 달 몫으로 셀 것인가」 — 가장 최근 달을 보고 있을 때만.
   *
   * 자료가 9/17 까지인데 오늘이 10월 1일이면 화면은 9월을 보고 있고, 그날 남긴
   * 기록의 날짜는 10-01 입니다. 달 접두어로만 세면 그 기록이 어디에도 안 잡혀
   * 「9월 긴급 인원」이 확인할수록 줄어듭니다.
   */
  const handledAfter = useMemo(
    () => (calMonthEndStr >= DATA_END_STR ? calMonthEndStr : undefined),
    [calMonthEndStr],
  );

  const assessAtStr = useMemo(() => {
    const end = new Date(calYear, calMonth, 0);
    const monthEnd = `${calYear}-${String(calMonth).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
    return monthEnd > DATA_END_STR ? DATA_END_STR : monthEnd;
  }, [calYear, calMonth]);
  const assessAt = useMemo(() => new Date(assessAtStr + "T00:00:00"), [assessAtStr]);

  // 위험도 판단은 화면 여러 곳에서 쓰이므로 한 번만 계산해 재사용합니다.
  const assessments = useMemo(
    () =>
      new Map<string, AiRiskAssessment>(
        activeResidents.map((r) => [r.id, getAiRiskAssessment(r, assessAt)]),
      ),
    [version, activeResidents, assessAt],
  );

  const attendanceRefDate = getLastOperatingDateInMonth(calYear, calMonth);
  const attendanceRefDetail = attendanceRefDate ? getDayDetail(attendanceRefDate) : null;
  const attendanceRefLabel = attendanceRefDate
    ? `${Number(attendanceRefDate.slice(5, 7))}월 ${Number(attendanceRefDate.slice(8, 10))}일 출석 인원`
    : `${calMonth}월 출석 인원`;

  const crisisEntries = useMemo(
    () => getMonthRiskEntries(calYear, calMonth, "crisis"),
    [version, calYear, calMonth],
  );
  const cautionEntries = useMemo(
    () => getMonthRiskEntries(calYear, calMonth, "caution"),
    [version, calYear, calMonth],
  );
  const monthlyAttendanceRoster = activeResidents
    .map((r) => ({ resident: r, stats: getMonthlyStats(r, calYear, calMonth) }))
    .sort((a, b) => b.stats.present - a.stats.present);

  const kpiListTitles: Record<KpiListKind, string> = {
    today: attendanceRefLabel,
    crisis: `${calYear}년 ${calMonth}월 긴급 인원`,
    caution: `${calYear}년 ${calMonth}월 위기 인원`,
    avgAttendance: `${calYear}년 ${calMonth}월 어르신별 출석 횟수`,
  };

  const kpiListEntries: Record<KpiListKind, KpiEntry[]> = {
    today: (attendanceRefDetail?.present ?? [])
      .map((p) => activeResidents.find((r) => r.id === p.id))
      .filter((r): r is Resident => !!r)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => {
        const risk = getCurrentRisk(r);
        return { resident: r, rightLabel: `${risk.rate}%`, badge: risk.level };
      }),
    crisis: crisisEntries,
    caution: cautionEntries,
    // 출석 횟수 목록에는 **등급 배지를 붙이지 않습니다.**
    //
    // 여기만 월 출석률 50/70/85 라는 다른 문턱으로 「위기」「주의」를 칠했습니다. 사양의
    // 등급은 절벽점수 3/10/18 하나뿐입니다. 그래서 평소 주 1회 오시고 이번 달도 정확히
    // 주 1회 오신 분(20%)이 여기서는 빨간 「위기」인데 조기개입 목록에는 없었습니다.
    // 판정식이 둘이면 둘 다 안 믿게 됩니다 — 여기서는 횟수만 보여줍니다.
    avgAttendance: monthlyAttendanceRoster.map(({ resident, stats }) => ({
      resident,
      rightLabel: `${stats.present}회 / ${stats.total}일 (${stats.rate}%)`,
    })),
  };

  // ★ 판정을 멈춘 날에는 명단도 열지 않습니다.
  //   카드는 「—」인데 누르면 「긴급 인원 (63명)」이 열렸습니다 — 안 들어온 자료로
  //   만들어진 바로 그 대량 오탐입니다. 막아둔 것을 옆문으로 보여주는 셈이었습니다.
  const openKpiList = (kind: KpiListKind, blocked = false) => {
    if (blocked && (kind === "crisis" || kind === "caution")) {
      toast.warning(
        "자료가 덜 들어와 오늘은 판정을 멈췄습니다 — 이 명단은 지금 믿을 수 없어 열지 않습니다.",
      );
      return;
    }
    setListDialog({ title: kpiListTitles[kind], entries: kpiListEntries[kind] });
  };

  // 직전 운영일 기준 판단과 비교해, 오늘 새로 위기·주의로 올라온 분을 표시합니다.
  // 매일 아침 이 화면을 볼 때 "어제와 무엇이 달라졌나"가 가장 먼저 알아야 할 정보입니다.
  const prevDate = attendanceRefDate ? getPreviousOperatingDate(attendanceRefDate) : null;
  const prevLevels = useMemo(
    () =>
      new Map<string, RiskLevel>(
        prevDate
          ? activeResidents.map((r) => [
              r.id,
              getAiRiskAssessment(r, new Date(prevDate)).level as RiskLevel,
            ])
          : [],
      ),
    [version, activeResidents, prevDate],
  );
  const isNewlyEscalated = (residentId: string, level: RiskLevel) => {
    if (!prevDate) return false;
    const before = prevLevels.get(residentId);
    if (!before) return false;
    return SEVERITY_ORDER[level] < SEVERITY_ORDER[before];
  };

  const managementEntries = activeResidents
    .map((r) => ({ resident: r, assessment: assessments.get(r.id)! }))
    .filter((e) => e.assessment.level === "crisis" || e.assessment.level === "caution")
    .map((e) => ({
      ...e,
      isNew: isNewlyEscalated(e.resident.id, e.assessment.level),
      followup: getLatestFollowup(e.resident.id, assessAtStr),
    }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.assessment.level] - SEVERITY_ORDER[b.assessment.level] ||
        a.assessment.attendanceRate - b.assessment.attendanceRate,
    );

  const newlyEscalatedCount = managementEntries.filter((e) => e.isNew).length;

  // 선택한 달 말일 기준으로 계산해, 위 KPI(위기·주의)와 아래 조기개입 목록이 항상 같은
  // 기준일·같은 판정을 씁니다. getRiskWorklist가 자료 마지막 날 이후는 자동으로 당겨줍니다.
  // 공급 실패 방어: 기준일 이용 인원이 평소보다 뚝 떨어지면 **판정 자체를 멈춥니다**.
  // (이 줄이 worklist 보다 위에 있어야 아래에서 판정을 막을 수 있습니다.)
  const inputGuard = useMemo(() => getInputGuardStatus(assessAtStr), [version, assessAtStr]);

  // ★ 자료가 평소의 30% 미만이면 그날은 판정하지 않습니다 (구현요청서 10장).
  //
  //   예전에는 붉은 배너만 띄우고 명단은 그대로 계산해 보여줬습니다. 추출이 절반만 성공해
  //   300명 오시던 날에 25명만 들어오면, 안 들어온 275명이 전부 그날 결석으로 적립돼
  //   다음날 위기 목록이 수십 명이 됩니다. 사양이 막으려던 상황 그대로입니다.
  //
  //   "감지가 며칠 늦어지는 건 회복되지만, 잘못된 대량 알림은 회복되지 않습니다."
  // 출력 방어 (사양 10장) — 신규 진입이 평소의 3배를 넘으면 오늘 목록을 내보내지 않습니다.
  //
  // 입력 방어와 막는 것이 다릅니다. 입력은 "자료가 덜 들어온" 경우이고, 이쪽은 **인원은
  // 멀쩡한데 정제가 틀어진** 경우입니다(일괄발권 탐지 실패 등). 그때는 입력 방어를 그냥
  // 통과하면서 갑자기 수십 명이 위기로 뜹니다. 사양이 "잘못된 대량 알림은 회복되지
  // 않습니다"라고 못박은 상황이 이것입니다.
  //
  // 만들어만 두고 아무 데서도 부르지 않고 있었습니다.
  const outputGuard = useMemo(() => getOutputGuardStatus(assessAtStr), [version, assessAtStr]);
  const judgementBlocked = inputGuard.status === "block" || outputGuard.status === "hold";
  const worklist = useMemo(
    () => (judgementBlocked ? EMPTY_WORKLIST : getRiskWorklist(assessAtStr)),
    [version, assessAtStr, judgementBlocked],
  );
  // 전화가 계속 안 되는 분 / 반복해서 줄고 있는 분 (구현요청서 9-2, 9-5)
  const visitNeeded = useMemo(() => getVisitNeeded(assessAtStr), [version, assessAtStr]);
  const resumeOverdue = useMemo(() => getResumeOverdue(assessAtStr), [version, assessAtStr]);
  const repeatedDowngrades = useMemo(
    () => getRepeatedDowngrades(assessAtStr),
    [version, assessAtStr],
  );
  // 총원(모수)은 그 달 시점에 등록돼 있던 어르신 수. 2025년 달을 보면 396명보다 적습니다.
  const registeredCount = useMemo(
    () => getRegisteredCountAsOf(assessAtStr),
    [version, assessAtStr],
  );
  // 이 카드의 수와 통계 화면의 「전체 명부」가 다릅니다. 자료가 깨져 판정에서 빠진 분이
  // 이쪽에만 빠져 있기 때문입니다. 몇 명이 왜 빠졌는지 카드에 적어 두지 않으면
  // 보는 사람은 둘 중 하나가 틀렸다고 여깁니다 — 저희가 먼저 그렇게 헷갈렸습니다.
  const rosterTotal = useMemo(() => getRosterTotal(), [version]);
  const blockedCount = useMemo(() => getBlockedCount(), [version]);

  // 자료 최신성 — 앱이 보는 '오늘'은 자료의 마지막 날이라, 몇 주째 자료가 안 들어와도 화면은
  // 멀쩡해 보입니다. 실제 달력과 비교해 "며칠째 자료가 없는지"를 따로 보여줘야 합니다.
  const freshness = useMemo(() => getDataFreshness(20), [version]);

  // 판단 기준 기간 — "어느 달 자료로 지금 판단하는지"를 담당자가 알 수 있게 보여줍니다.
  // 기준선은 달력 개월이 아니라 **운영일 기준**(BASELINE_DAYS)이라, 월 운영일이 20일
  // 안팎이면 달력으로는 그보다 길게 걸칩니다(휴관이 많은 달이 끼면 더). 그래서 "최근 N개월"이
  // 아니라 자료에서 실제 범위를 계산해 표시합니다.
  const baselineWindow = useMemo(() => {
    // 판정과 **같은 규칙**으로 자릅니다 — 오늘은 뺍니다.
    //
    // 판정 쪽(classifyRisk)은 "오늘을 넣으면 오늘 하루가 기준선과 판정 양쪽에 들어가
    // 자기가 자기 기준을 흔든다"며 오늘을 뺍니다. 그런데 이 배너만 `<=` 로 넣고 있어,
    // 담당자에게 보여주는 구간이 실제 판정 구간보다 운영일 하루씩 뒤로 밀려 있었습니다.
    // 걸친 달이 바뀌는 날에는 "(3·4·5월 자료로 판단)" 목록까지 달라집니다.
    const win = OPERATING_DAYS.filter((d) => d < assessAtStr).slice(-BASELINE_DAYS);
    if (win.length === 0) return null;
    const months = Array.from(new Set(win.map((d) => Number(d.slice(5, 7)))));
    return { start: win[0], end: win[win.length - 1], days: win.length, months };
  }, [version, assessAtStr]);

  // 확인 기록이 "만료된 안심"인지: 안심 기한이 지났고 종결도 아니면, 다시 연락 대상입니다.
  const isStaleSnooze = (f: Followup | null) => {
    // isCleared 와 같은 규칙(recheckDueDate)을 씁니다. 예전에는 명시적 snoozeUntil 만 봐서,
    // 기한을 안 건 기록은 영원히 「만료 아님」이었습니다 — 그 결과 같은 분이 왼쪽
    // 「연락할 분」에 미확인으로 돌아와 있으면서 오른쪽 「연락 드린 분」에도 남았습니다.
    if (!f || isClosedFollowup(f)) return false;
    const due = recheckDueDate(f);
    return !!due && due < assessAtStr;
  };

  /**
   * 이 분을 「연락할 분」에서 빼도 되는가.
   *
   * 질문을 뒤집었습니다. 예전에는 **"기한이 지났는가"**를 물어 목록에 남겼는데,
   * 기한이 아예 없는 기록은 **영원히 지나지 않습니다.** 그래서 이런 일이 났습니다 —
   *
   *   「도움이 더 필요」  기한을 안 겁니다(당연합니다. 도와드려야 하니까요)
   *                      → 기한이 없으니 "지나지 않음" → **목록에서 영구히 빠짐**
   *
   * 가장 심각해서 개입이 필요하다고 적은 바로 그분이 제일 먼저 사라졌습니다.
   *
   * 이제 **뺄 이유가 있을 때만** 뺍니다. 뺄 이유는 둘뿐입니다.
   *   · 종결 — 급식으로 더 볼 수 없게 된 분
   *   · 아직 살아 있는 안심 기한 — 사유를 확인하고 언제까지 안 봐도 되는지 정해 둔 분
   * 부재중도, 도움이 더 필요도 제외 사유가 아닙니다.
   */
  // 판단은 엔진 한 곳(isRestingOn)에 있습니다. 예전에는 이 규칙이 화면마다 따로
  // 적혀 있어서, 「연락할 분」과 「사유를 확인한 분」이 같은 분을 두고 서로 다른
  // 답을 내는 날이 있었습니다.
  const isCleared = (f: Followup | null) => !!f && isRestingOn(f, assessAtStr);

  // 연락은 드렸지만 **닿지 않은** 기록. 이건 해제 사유가 아닙니다.
  //
  // 사양: "확인 불가는 해제 사유가 아님 — 연락이 안 되는 것 자체가 위기 신호". 그런데
  // 부재중을 적으면 왼쪽에서 사라지고 오른쪽 '연락 드린 분'으로 넘어갔습니다. 화면은
  // "목록에 그대로 둡니다"라고 안내하면서 실제로는 빼고 있었습니다.
  //
  // 연락이 안 된 분은 **양쪽에 다 있어야** 맞습니다 — 오른쪽은 "언제 걸었나"의 기록이고,
  // 왼쪽은 "아직 확인 못 했으니 다시 걸어야 한다"는 할 일입니다.
  const isUnreachable = (f: Followup | null) =>
    !!f && (f.resultKind === "확인불가" || f.outcome === "no_answer");

  // 왼쪽 "연락할 분" = 조기개입 중 (아직 연락 안 함) 또는 (안심 기한이 지나 다시 봐야 함)
  // 또는 (연락했지만 닿지 않음).
  /**
   * 「연락 드린 분」을 무엇으로 세울지.
   *
   * 기본은 **지원 필요 우선**입니다. 예전에는 최신순 하나뿐이라, 오늘 적은 기록이 위로
   * 올라오고 「도움이 더 필요」로 적어 둔 분이 며칠 지나면 아래로 밀려 내려갔습니다.
   * 이 목록에서 담당자가 다시 찾는 것은 방금 적은 것이 아니라 **아직 마무리 안 된 분**
   * 입니다. 최신순도 그대로 고를 수 있게 둡니다.
   */
  const [contactedSort, setContactedSort] = useState<"support" | "recent" | "level">("support");

  /**
   * 이 달 🔴 위기 어르신 — **연락드린 분까지 포함해 전원**.
   *
   * 사유를 확인해 기한을 걸면 등급이 normal 로 바뀌어 earlyIntervention 에서 빠집니다.
   * 그래서 화면에는 「위기 1명」이라 적히는데 실제로는 열한 분이 위기였던 달이 있었습니다.
   * 가려 둔 것과 괜찮아진 것은 다릅니다. acknowledged 통에서 **가려지기 전 등급**이
   * 위기였던 분을 다시 끌어옵니다.
   */
  const crisisAll = useMemo(
    () => [
      ...worklist.earlyIntervention.filter((e) => e.level === "crisis"),
      ...worklist.acknowledged.filter((e) => (e.levelBeforeSnooze ?? e.level) === "crisis"),
    ],
    [worklist],
  );
  /** 위기(옛 주의)도 같은 방식으로 셉니다. */
  const cautionAll = useMemo(
    () => [
      ...worklist.earlyIntervention.filter((e) => e.level === "caution"),
      ...worklist.acknowledged.filter((e) => (e.levelBeforeSnooze ?? e.level) === "caution"),
    ],
    [worklist],
  );
  /**
   * 「연락할 분」에 올릴 전체 — 🔴 긴급과 🟠 위기 **두 등급**.
   *
   * 예전에는 긴급만 올렸습니다. 목록을 짧게 두려던 것인데, 현장에서는 두 등급 모두에
   * 전화를 겁니다. 화면에 없는 분께 전화를 거는 셈이 되어, 어디까지 했는지 목록으로
   * 확인할 수가 없었습니다. 둘 다 올리고 **순서로** 급한 정도를 말합니다.
   *
   * 🟢 관심은 넣지 않습니다. 이분들은 전화하는 분이 아니라 급식에 오시면 자동으로
   * 빠지는 분입니다. 넣으면 목록이 두 배가 되면서 「할 일 목록」이 아니게 됩니다.
   */
  const callAll = useMemo(() => [...crisisAll, ...cautionAll], [crisisAll, cautionAll]);

  const toContact = useMemo(
    () =>
      callAll
        // ★ **다시 볼 날이 왔을 때만** 여기 세웁니다.
        //
        //   한동안 「이번 달 안에 다시 볼 분」까지 남겨 두었습니다. 목록만 보고도 그 달
        //   긴급·위기가 몇 분인지 알 수 있게 하려던 것인데, 그러면 이런 일이 납니다 —
        //
        //     변○또 어르신 · 9/18 「도움이 더 필요」로 확인 · 9/25 에 다시 보기로 함
        //     → 9/19 에도 20 일에도 「연락할 분」에 그대로 서 계십니다
        //
        //   오늘 할 일이 아닌데 할 일 목록에 있습니다. 담당자는 "확인했는데 왜 또 있지"
        //   하며 기록을 다시 열어 보게 되고, 몇 번 반복되면 목록 전체를 안 믿습니다.
        //
        //   그 달 인원은 이제 위 요약 카드가 셉니다(getMonthHandled). 목록이 그 일까지
        //   떠맡을 이유가 없어졌습니다. 여기는 **오늘 해야 할 일**만 둡니다.
        //
        //   다시 볼 날이 안 온 분은 아래 「사유를 확인한 분」 상자에 날짜와 함께 있습니다.
        //   사라지는 것이 아닙니다.
        .filter((e) => {
          const f = getLatestFollowup(e.resident.id, assessAtStr);
          // 아직 연락 안 했거나 · 부재중이거나 · 다시 볼 날이 지났으면 남습니다.
          return !f || !isCleared(f);
        })
        // 업무 순서로 줄을 세웁니다. 위험도만으로 세우면 "오늘 뭘 먼저 해야 하나"가
        // 안 보입니다 — 이미 세 번 전화한 분과 아직 한 번도 안 건 분이 섞입니다.
        //   0 아직 연락 안 함      가장 먼저
        //   1 연락했는데 안 받으심  다시 걸어야 함
        //   2 안심 기한이 지남      다시 볼 때가 됨
        //   3 이미 확인함           맨 아래. 오늘 할 일이 아닙니다
        // 같은 칸 안에서는 원래 순서(위험도)를 그대로 둡니다.
        .map((e, i) => {
          const f = getLatestFollowup(e.resident.id, assessAtStr);
          // 등급 순서도 함께 봅니다. 세 등급이 한 목록에 섞이므로, 같은 「아직 연락 안 함」
          // 안에서는 긴급 → 위기 → 관심 순으로 서야 위에서부터 거는 것이 맞습니다.
          const lv = e.levelBeforeSnooze ?? e.level;
          const grade = lv === "crisis" ? 0 : lv === "caution" ? 1 : 2;
          return {
            e,
            i,
            grade,
            rank: !f ? 0 : isUnreachable(f) ? 1 : isCleared(f) ? 3 : 2,
            done: !!f && isCleared(f),
          };
        })
        .sort((a, b) => a.rank - b.rank || a.grade - b.grade || a.i - b.i)
        .map((x) => ({ ...x.e, done: x.done })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [callAll, version, assessAtStr, calMonthEndStr],
  );
  /** 아직 연락 안 한 분 수 — 오늘 실제로 해야 할 일의 크기입니다. */
  const pendingCount = useMemo(() => toContact.filter((e) => !e.done).length, [toContact]);
  /**
   * 등급별로 「이미 확인한 분」을 따로 셉니다.
   *
   * 예전에는 목록 전체의 pendingCount 하나를 두 카드가 함께 썼습니다. 목록에 위기까지
   * 들어오자 긴급 카드에 「연락 -24명」이라는 음수가 떴습니다 — 긴급 5명에서 목록 전체의
   * 남은 29명을 뺀 값입니다. 카드마다 자기 분모를 써야 합니다.
   */
  //   ★ 「연락했는가」를 셉니다. 「지금도 안심 기한 안인가」가 아닙니다.
  //
  //   두 질문이 다릅니다. isCleared 로 세면, 지난 달을 되짚어 볼 때 그 달에 분명히
  //   통화를 마친 분이 「남은 N명」으로 되돌아옵니다 — 기한이 그 달 안에 이미 끝났기
  //   때문입니다. 7월 긴급 12명을 전원 통화했는데 「연락 4명 · 남은 8명」으로 보였습니다.

  /**
   * 요약 카드에 쓸 **그 달 전원**.
   *
   * crisisAll/cautionAll 은 「오늘 전화할 목록」을 만드는 값이라, 사유가 밝혀져 판정이
   * 멈춘 분(일시적사정·이용감소·일자리참여)과 종결된 분(사망·이사·요양원)이 빠집니다.
   * 그건 목록으로는 맞지만 **카드 숫자로는 틀립니다** — 전화를 돌릴수록 「9월 긴급
   * 인원」이 줄어들어, 확인한 일이 없던 일이 됩니다.
   *
   * 그 달에 그 등급으로 감지돼 확인 기록이 남은 분을 다시 더해 셉니다(getMonthHandled).
   */
  const monthTotals = useMemo(() => {
    // ★ 「남은」을 둘로 가릅니다.
    //
    //   예전에는 「연락 10명 · 남은 1명」이라고만 적었습니다. 그런데 그 1명은 전화를
    //   안 건 분이 아니라 **걸었는데 두 번 다 안 받으신 분**이었습니다. 담당자는
    //   그날 열한 분께 전부 전화를 돌렸는데, 화면은 한 분을 빠뜨린 것처럼 적어
    //   두었습니다 — "다 했는데 왜 남았지?" 가 나옵니다.
    //
    //   두 가지는 해야 할 일이 다릅니다. 부재중은 다시 걸어야 하는 분이고,
    //   미연락은 아직 시작도 안 한 분입니다. 그러니 따로 세어 따로 적습니다.
    const build = (level: "crisis" | "caution", live: typeof crisisAll) => {
      const ids = new Set(live.map((e) => e.resident.id));
      for (const id of getMonthHandled(calYear, calMonth, level, handledAfter).keys()) ids.add(id);
      let done = 0; // 통화가 되어 사정을 알아낸 분
      let noAnswer = 0; // 걸었는데 못 만난 분
      let never = 0; // 아직 한 번도 안 건 분
      for (const id of ids) {
        const f = getLatestFollowup(id, assessAtStr);
        if (!f) never++;
        else if (isUnreachable(f)) noAnswer++;
        else done++;
      }
      return { total: ids.size, done, noAnswer, never };
    };
    return { crisis: build("crisis", crisisAll), caution: build("caution", cautionAll) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crisisAll, cautionAll, version, assessAtStr, calYear, calMonth]);
  /**
   * 사유를 확인해 기한을 둔 분 / 종결한 분.
   *
   * 여기도 **등급에서 뽑으면 안 됩니다.** 실제로 이런 일이 났습니다 —
   *
   *   홍○순  "다음 달부터 다시 오신다" 확인, 10/15까지 안심
   *          → 60일 내내 결석이라 기준선이 0이 되어 **어느 목록에도 없게** 됨
   *   홍○자  "[종결] 멀리 이사 가심"
   *          → 「잠시 제외」 상자에 들어감. 종결은 잠시가 아니라 완전히 빠지는 것입니다
   *
   * 확인 기록은 사람이 남긴 사실입니다. 그날의 계산 결과가 어떻든 남아 있어야 합니다.
   * 등급은 "누구에게 연락할까"를 정하고, 이 상자는 "이미 확인해 둔 분"을 보여줍니다.
   */
  const acknowledgedFromRecords = useMemo(() => {
    const cutoff = followupCutoff(assessAtStr);
    const latest = new Map<string, Followup>();
    for (const f of FOLLOWUPS) {
      if (f.checkedAt > cutoff) continue;
      const cur = latest.get(f.residentId);
      if (!cur || f.checkedAt > cur.checkedAt || (f.checkedAt === cur.checkedAt && f.id > cur.id)) {
        latest.set(f.residentId, f);
      }
    }
    const snoozed: { resident: Resident; followup: Followup }[] = [];
    const paused: { resident: Resident; followup: Followup }[] = [];
    const closed: { resident: Resident; followup: Followup }[] = [];
    for (const f of latest.values()) {
      const resident = getResidentById(f.residentId);
      if (!resident) continue;
      if (isClosedFollowup(f)) {
        closed.push({ resident, followup: f });
        // ★ 약속한 복귀일이 지난 분은 이 상자에서 뺍니다.
        //
        //   판정은 이미 재개돼(getMemberState 가 감시중 + resumeOverdue) 왼쪽 「연락할 분」과
        //   「📅 나오신다고 하신 날이 지났습니다」 상자에 올라와 있는데, 이 상자는 기록만 보고
        //   판단해서 **같은 분을 「당분간 목록에서 뺍니다」 쪽에도 계속 세워 뒀습니다.**
        //   한 화면에서 같은 어르신이 "다시 봐야 함"과 "안 봐도 됨" 양쪽에 있었습니다.
      } else if (getMemberState(resident, assessAtStr).status === "보류") {
        // 입원·일자리 참여처럼 사정을 알아 판정을 멈춘 분. 판정 엔진은 이분들을
        // 「자료 부족」으로 뭉개 어느 목록에도 안 남깁니다 — 여기서 붙잡습니다.
        paused.push({ resident, followup: f });
      } else {
        // 여기서도 같은 규칙을 씁니다. 안 그러면 「연락할 분」에서는 빠졌는데 이 상자에도
        // 안 들어와, 연락드린 분이 **어느 목록에도 없는** 구간이 생깁니다.
        // 목록과 **겹치지 않게** 나눕니다. 이번 달 안에 다시 볼 분은 위 「연락할 분」에
        // 남아 있으므로, 여기에는 달을 넘겨 미룬 분만 둡니다. 같은 분이 한 화면에서
        // 「연락할 분」과 「당분간 목록에서 뺍니다」 양쪽에 있으면 안 됩니다.
        const due = recheckDueDate(f);
        // 약속한 복귀일이 지난 분은 여기에도 두지 않습니다. 위 「보류」 가지에서만 막았더니
        // 가드에 걸린 분이 이 else 로 흘러들어, 「📅 나오신다고 하신 날이 지났습니다」와
        // 「당분간 목록에서 뺍니다」가 한 화면에서 정반대를 말했습니다.
        // 「이번 달을 넘겼는가」가 아니라 **「다시 볼 날이 아직 안 왔는가」**로 가릅니다.
        // 위 「연락할 분」이 같은 기준(isCleared)을 쓰므로, 두 상자가 한 사람을 두고
        // 서로 다른 말을 하지 않습니다 — 한쪽에서 빠지면 반드시 다른 쪽에 있습니다.
        if (due && due >= assessAtStr && !getMemberState(resident, assessAtStr).resumeOverdue) {
          snoozed.push({ resident, followup: f });
        }
      }
    }
    snoozed.sort((a, b) =>
      (a.followup.snoozeUntil ?? "").localeCompare(b.followup.snoozeUntil ?? ""),
    );
    paused.sort((a, b) => b.followup.checkedAt.localeCompare(a.followup.checkedAt));
    closed.sort((a, b) => b.followup.checkedAt.localeCompare(a.followup.checkedAt));
    return { snoozed, paused, closed };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, assessAtStr, calMonthEndStr]);

  // 오른쪽 "연락 드린 분" = 최근 CONTACTED_WINDOW_DAYS 일 안에 적은 확인 기록. 최신순.
  //
  // **등급에서 뽑지 않고 기록에서 뽑습니다.** 이게 두 번 문제가 됐습니다. 처음에는
  // earlyIntervention 안에서만 찾아서, 확인 기록을 남기는 순간 그분이 화면에서 통째로
  // 사라졌습니다. acknowledged 를 더해 고쳤지만 같은 일이 또 났습니다 — 사유를 확인해
  // 안심 처리한 분이 며칠 뒤 등급이 정상으로 돌아오면 두 바구니 어디에도 없게 되어,
  // 어제 적은 기록이 흔적도 없이 사라집니다.
  //
  // 이 목록은 위험도 목록이 아니라 **업무 일지**입니다. "이번 달에 누구에게 연락했고
  // 결과가 무엇이었나". 그러니 그날의 등급이 아니라 남긴 기록이 기준이어야 합니다.
  const contacted = useMemo(() => {
    // 한 달 전 날짜. 문자열로 자르면 월이 바뀔 때 틀리므로 달력으로 셉니다.
    const [y, mo, d] = assessAtStr.split("-").map(Number);
    const sd = new Date(y, mo - 1, d - CONTACTED_WINDOW_DAYS);
    const since = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, "0")}-${String(sd.getDate()).padStart(2, "0")}`;
    const latest = new Map<string, Followup>();
    for (const f of FOLLOWUPS) {
      if (f.checkedAt < since || f.checkedAt > followupCutoff(assessAtStr)) continue;
      const cur = latest.get(f.residentId);
      if (!cur || f.checkedAt > cur.checkedAt || (f.checkedAt === cur.checkedAt && f.id > cur.id)) {
        latest.set(f.residentId, f);
      }
    }
    return (
      [...latest.values()]
        // 안심 기한이 지난 분은 왼쪽 '연락할 분'으로 돌아갑니다. 양쪽에 다 두면 헷갈립니다.
        .filter((f) => !isStaleSnooze(f))
        .map((f) => ({ resident: getResidentById(f.residentId), followup: f }))
        .filter((x): x is { resident: Resident; followup: Followup } => !!x.resident)
        .sort((a, b) => {
          const newest =
            b.followup.checkedAt.localeCompare(a.followup.checkedAt) ||
            b.followup.id.localeCompare(a.followup.id);
          if (contactedSort === "recent") return newest;
          if (contactedSort === "level") {
            // 긴급 → 위기 → 관심 → 그 외. 같은 등급 안에서는 최신순.
            const rank = (r: Resident) => {
              const lv = assessments.get(r.id)?.level;
              return lv === "crisis" ? 0 : lv === "caution" ? 1 : lv === "concern" ? 2 : 3;
            };
            return rank(a.resident) - rank(b.resident) || newest;
          }
          // support(기본): 아직 마무리 안 된 분 먼저.
          //   0 도움이 더 필요   — 손이 더 가야 하는 분
          //   1 부재중           — 아직 못 만난 분
          //   2 그 외(확인 완료·멈춤·종결)
          const done = (f: Followup) =>
            f.outcome === "needed" ? 0 : f.outcome === "no_answer" ? 1 : 2;
          return done(a.followup) - done(b.followup) || newest;
        })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worklist, version, assessAtStr, contactedSort, assessments]);

  // 요약 카드에서 바로 명단을 열 수 있게. (toContact·contacted가 위에서 정해지므로 여기 둡니다)
  const openContactedList = () =>
    setListDialog({
      title: `${calMonth}월 연락 드린 분`,
      entries: contacted.map(({ resident, followup }) => ({
        resident,
        // ★ 부재중이 「확인」으로 찍히던 자리입니다. 같은 분이 왼쪽 목록에서는
        //   「📵 부재중 N회째」인데 여기서는 확인이 끝난 것처럼 보였습니다.
        rightLabel: `${followup.checkedAt.slice(5)} ${
          followup.note.startsWith("[종결]")
            ? "종결"
            : followup.outcome === "no_answer" || followup.resultKind === "확인불가"
              ? "부재중"
              : followup.outcome === "needed"
                ? "도움이 더 필요"
                : "지금은 괜찮으심"
        }`,
        // 판정 대상이 아닌 분(퇴소·자료오류 등)에게 근거 없이 「위기」를 붙이지 않습니다.
        badge: assessments.get(resident.id)?.level ?? "unknown",
      })),
    });

  // 아직 설명이 없거나, 확인 기록이 들어와 다시 봐야 하는 분 수. 단추에 띄웁니다 —
  // 몇 명이 기다리는지 안 보이면 눌러야 할 때를 알 수 없습니다.
  const aiPending = useMemo(
    () =>
      worklist.earlyIntervention.filter((e) => !e.resident.aiSummary || e.resident.aiNeedsUpdate)
        .length,
    [worklist],
  );

  // 조기개입 목록을 한 분씩(1인 1호출) AI로 분석. 상한 넘으면 자동 중단.
  const runAi = async (all = false) => {
    if (aiRunning) return;
    // 누구를 다시 부르는가 — 세 경우입니다.
    //
    //   ① 설명이 아직 없는 분      새로 등록되신 분이 여기 해당합니다
    //   ② 다시 봐야 하는 분        확인 기록이 들어오면 데이터베이스 트리거가 표시합니다.
    //                              담당자가 전화해서 뭔가 알아낸 순간이 어제 쓴 설명이 낡는
    //                              순간입니다
    //   ③ 전부 (all=true)          판정 로직을 고쳤을 때. 그때는 예전 설명이 전부 낡습니다
    //
    // ①②만 고르는 것이 기본입니다 — 이미 설명이 있는 분을 다시 부르면 돈만 듭니다.
    const targets = worklist.earlyIntervention.filter(
      (e) => all || !e.resident.aiSummary || e.resident.aiNeedsUpdate,
    );
    if (targets.length === 0) {
      toast.info(
        "새로 분석할 분이 없습니다. 이미 있는 설명까지 새로 쓰려면 옆의 「일괄 갱신」을 누르세요.",
      );
      return;
    }
    if (
      all &&
      !window.confirm(`${targets.length}명의 설명을 전부 새로 만듭니다.

약 ${Math.round(targets.length * 2)}원이 듭니다. 계속할까요?`)
    ) {
      return;
    }
    setAiRunning(true);
    setAiProgress({ done: 0, total: targets.length });
    const res = await runAiAssessments(targets, (id, summary, spent, cap) => {
      setResidentAiSummary(id, summary);
      setAiSpend({ spent, cap });
      // 동시에 여러 건이 끝나므로 이전 값에서 올립니다(덮어쓰면 하나씩 샙니다).
      setAiProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
    });
    setAiRunning(false);
    setAiProgress(null);
    if (res.error) toast.error(`AI 설명 오류: ${res.error}`);
    else if (res.paused)
      toast.warning(`월 비용 상한($${res.cap})에 도달해 멈췄습니다. ${res.done}명 완료.`);
    else toast.success(`${res.done}명 AI 설명 완료.`);
    void fetchAiSpend().then(setAiSpend);
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-stone-50">
      <NavBar />
      {/* 상징 마크 — 화면 뒤에 크게 아주 옅게 깔아 이 도구가 무엇을 위한 것인지 남겨둡니다.
          하트는 흐릿하게 두고 가운데 박동선만 훑고 지나갑니다. */}
      <HeartbeatWatermark className="absolute -right-28 top-2 h-[20rem] w-[20rem] opacity-70 sm:-right-16 sm:top-6 sm:h-[38rem] sm:w-[38rem] sm:opacity-100" />
      <main className="relative mx-auto max-w-7xl px-6 py-8">
        {/* 서비스 이름을 로고와 함께 앞세워, 이 도구가 무엇을 하는 도구인지 첫 줄에서 알 수 있게 합니다. */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/[0.07]">
              <BapsangMark className="h-8 w-8 text-primary" />
            </span>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">밥상위의 신호</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {attendanceRefDate ? `${formatDateWithWeekday(attendanceRefDate)} 기준 · ` : ""}
                식사 출석 패턴에서 위기 신호를 찾고, 연락한 결과로 확인합니다
              </p>
            </div>
          </div>
        </div>

        {/* 조회 월 — 아래 요약·관리군·외부변수·대응 이력이 모두 이 달 기준으로 바뀝니다. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-medium text-muted-foreground">조회 월</span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              aria-label="이전 달"
              disabled={monthIdx <= 0}
              onClick={() => monthIdx > 0 && setMonthKey(toKey(monthOptions[monthIdx - 1]))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Select value={monthKey} onValueChange={setMonthKey}>
              <SelectTrigger className="h-8 w-36 bg-white text-sm font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...monthOptions].reverse().map((m) => (
                  <SelectItem key={toKey(m)} value={toKey(m)}>
                    {m.year}년 {m.month}월
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              aria-label="다음 달"
              disabled={monthIdx < 0 || monthIdx >= monthOptions.length - 1}
              onClick={() =>
                monthIdx < monthOptions.length - 1 && setMonthKey(toKey(monthOptions[monthIdx + 1]))
              }
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {monthKey !== thisMonthKey && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setMonthKey(thisMonthKey)}
            >
              이번 달로
            </Button>
          )}
          {monthKey !== thisMonthKey && (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
              지난 기록을 보고 있습니다
            </span>
          )}
        </div>

        {/* 판단 기준 기간 — 지금 명단이 "어느 달 자료로" 나온 것인지 알려줍니다. */}
        {baselineWindow && (
          <div className="mb-3 rounded-lg border border-stone-200 bg-white px-4 py-2 text-xs">
            <b className="font-semibold text-foreground">판단 기준 자료</b>
            <span className="text-muted-foreground">
              {" "}
              · 최근 운영일 {baselineWindow.days}일 ={" "}
              <span className="tabular-nums text-foreground">
                {baselineWindow.start.replace(/-/g, ".")} ~ {baselineWindow.end.replace(/-/g, ".")}
              </span>{" "}
              (<b className="font-medium text-foreground">{baselineWindow.months.join("·")}월</b>{" "}
              자료로 판단)
            </span>
          </div>
        )}

        {/* 공급 실패 방어 배너 — 기준일 이용 인원이 평소보다 뚝 떨어졌을 때만 뜹니다. */}
        {/* 출력 방어 배너. 입력 방어와 같은 자리·같은 모양으로 둡니다 — 담당자가 알아야 할
            것은 둘 다 "오늘 판정을 믿지 마세요" 하나입니다. */}
        {outputGuard.status === "hold" && (
          <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            <b className="font-semibold">⛔ 새로 올라온 분이 너무 많습니다 — 판정을 멈췄습니다</b>{" "}
            오늘 새로 위기·주의로 올라온 분이 <b>{outputGuard.todayNew}명</b>입니다. 지난 4주 평균은{" "}
            <b>{outputGuard.recentAvg}명</b>이라, 평소의{" "}
            {outputGuard.recentAvg > 0
              ? Math.round((outputGuard.todayNew / outputGuard.recentAvg) * 10) / 10
              : "—"}
            배입니다. <b className="font-semibold">아래 목록을 비워 두었습니다.</b> 자료는 평소만큼
            들어왔는데 이만큼 늘었다면 정제가 어긋났을 가능성이 큽니다. 수십 명에게 잘못 연락드리면
            되돌릴 수 없습니다.
            <Link to="/stats" className="ml-1 font-semibold underline">
              분석에서 뺀 날 확인하기 ›
            </Link>
          </div>
        )}

        {inputGuard.status !== "ok" && (
          <div
            className={`mb-3 rounded-lg border px-4 py-3 text-sm ${
              inputGuard.status === "block"
                ? "border-red-300 bg-red-50 text-red-900"
                : "border-amber-300 bg-amber-50 text-amber-900"
            }`}
          >
            <b className="font-semibold">
              {inputGuard.status === "block"
                ? "⛔ 데이터 확인 중 — 판정을 믿지 마세요"
                : "⚠️ 이용 인원이 평소보다 적습니다"}
            </b>{" "}
            {inputGuard.date && `${inputGuard.date.slice(5)} `}이용 {inputGuard.todayCount}명 (평소{" "}
            {inputGuard.refMedian}명의 {Math.round(inputGuard.ratio * 100)}%).
            {inputGuard.status === "block" ? (
              <>
                {" "}
                자료가 덜 들어온 것으로 보입니다.{" "}
                <b className="font-semibold">
                  그래서 오늘은 판정을 멈췄습니다 — 아래 목록을 비워 두었습니다.
                </b>{" "}
                안 들어온 분이 전부 결석으로 잡히면 수십 명이 한꺼번에 위기로 뜨고, 그런 알림은
                되돌릴 수 없습니다. 감지가 하루 늦는 것이 낫습니다.
                <Link to="/resources" className="ml-1 font-semibold underline">
                  자료 관리에서 확인하기 ›
                </Link>
              </>
            ) : (
              " 실제 휴관·행사·폭설일 수 있으니 한 번 확인하세요."
            )}
          </div>
        )}

        {/* 자료 업데이트 현황 — 네모 한 칸이 평일 하루. 초록이면 그날 자료가 들어와 있습니다.
            앱이 보는 '오늘'은 자료의 마지막 날이라, 이 줄이 없으면 몇 주째 자료가 안 들어와도
            화면이 멀쩡해 보입니다. */}
        <Card
          className={`mb-4 p-4 ${
            freshness.status === "stale"
              ? "border-red-300 bg-red-50/60"
              : freshness.status === "warn"
                ? "border-amber-300 bg-amber-50/60"
                : ""
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">자료 업데이트 현황</span>
              {freshness.status === "ok" ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                  최신
                </span>
              ) : (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    freshness.status === "stale"
                      ? "bg-red-600 text-white"
                      : "bg-amber-500 text-white"
                  }`}
                >
                  {freshness.status === "stale" ? "자료 밀림" : "확인 필요"}
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              마지막 자료{" "}
              <b className="font-semibold tabular-nums text-foreground">
                {freshness.lastDataDate ?? "–"}
              </b>
              {freshness.gapDays > 0 && ` · ${freshness.gapDays}일 전`}
            </span>
          </div>

          {/* 최근 평일 20일 — 네모 아래에 날짜를 적어 어느 날인지 바로 알 수 있게 합니다. */}
          <div className="mt-2.5 flex flex-wrap items-end gap-x-1.5 gap-y-2">
            {freshness.days.map((d, i) => {
              const [, mm, dd] = d.date.split("-");
              // 달이 바뀌는 첫 칸에는 '9/1'처럼 월을 함께, 나머지는 일자만 적어 빽빽함을 줄입니다.
              const prevMonth = i > 0 ? freshness.days[i - 1].date.slice(5, 7) : null;
              const showMonth = i === 0 || prevMonth !== mm;
              return (
                <span key={d.date} className="flex w-6 flex-col items-center gap-1">
                  <span
                    title={`${d.date} ${
                      d.excluded
                        ? "자료 있음(듬성듬성해 분석 제외)"
                        : d.hasData
                          ? "자료 있음"
                          : "자료 없음"
                    }`}
                    className={`h-4 w-4 rounded ${
                      d.excluded ? "bg-amber-300" : d.hasData ? "bg-emerald-400" : "bg-stone-200"
                    }`}
                  />
                  <span
                    className={`text-[9px] leading-none tabular-nums ${
                      showMonth ? "font-semibold text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {showMonth ? `${Number(mm)}/${Number(dd)}` : Number(dd)}
                  </span>
                </span>
              );
            })}
            <span className="ml-2 flex items-center gap-2 pb-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="h-3 w-3 rounded bg-emerald-400" /> 자료 있음
              </span>
              <span className="flex items-center gap-1">
                <span className="h-3 w-3 rounded bg-stone-200" /> 없음
              </span>
              <span className="flex items-center gap-1">
                <span className="h-3 w-3 rounded bg-amber-300" /> 분석 제외
              </span>
            </span>
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {freshness.status === "ok" ? (
              <>
                최근 평일 자료가 잘 들어오고 있습니다. (네모 한 칸 = 평일 하루)
                {freshness.excludedDays > 0 && (
                  <>
                    {" "}
                    <b className="text-amber-800">
                      다만 {freshness.excludedDays}일은 앞뒤로 운영일이 너무 적어(자료가 듬성듬성)
                      분석에서 잠시 빠져 있습니다.
                    </b>{" "}
                    빠진 날짜의 자료를 마저 넣으면 자동으로 분석에 들어갑니다.
                  </>
                )}
              </>
            ) : (
              <>
                <b className={freshness.status === "stale" ? "text-red-700" : "text-amber-800"}>
                  평일 {freshness.missingWeekdays}일째 자료가 들어오지 않았습니다.
                </b>{" "}
                자료가 밀리면 최근 결석이 반영되지 않아 위기 신호가 늦게 뜹니다.{" "}
                <Link to="/resources" className="font-medium text-foreground underline">
                  자료 관리
                </Link>
                에서 엔컴 자료를 올려주세요.
              </>
            )}
          </p>
        </Card>

        {/* 요약 카드 */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {/* 출석 인원·일평균은 통계 화면으로 옮기고, 이 자리에는 "지금 해야 할 일"을 둡니다.
              모수(등록 어르신 수)는 따로 한 줄을 두지 않고 이 카드 아래에 붙여, "몇 명 중
              몇 명인지"를 한 자리에서 읽게 합니다. */}
          <SummaryCard
            label={`${calMonth}월 등록 어르신`}
            value={`${registeredCount}명`}
            note={
              blockedCount > 0 ? `오류 인원 ${blockedCount}명 제외` : `명부 전체 ${rosterTotal}명`
            }
            tone="info"
            // 전체 명단은 상단 메뉴의 「회원관리」에서 검색·필터로 봅니다.
            onClick={() => navigate({ to: "/members" })}
          />
          {/* 「위기 인원」이 줄어든 것처럼 보이는 일이 있었습니다.
              사유를 확인해 안심 처리하거나 종결한 분은 등급이 정상으로 바뀌어 이 숫자에서
              빠집니다. 의도한 동작이지만 이름이 「위기 인원」이라, 담당자는 "어제 4명이던
              게 왜 2명이지?"를 먼저 의심하게 됩니다. 빠진 인원을 같이 적습니다. */}
          {/* 「연락드린 분까지 포함한 전체 수」를 크게 적고, 그중 몇 분을 이미 보셨는지를
              아래에 적습니다.
              예전에는 아직 연락 안 한 분만 세었습니다. 그래서 열한 분이 위기였던 달에
              화면에는 「위기 1명」이라고 적혔습니다 — 열 분을 처리한 것이 위기가 없었던
              것처럼 보였습니다. 가린 것과 괜찮아진 것은 다릅니다. */}
          <SummaryCard
            label={`${calMonth}월 긴급 인원`}
            value={judgementBlocked ? "—" : `${monthTotals.crisis.total}명`}
            note={judgementBlocked ? undefined : describeProgress(monthTotals.crisis)}
            tone="danger"
            onClick={() => openKpiList("crisis", judgementBlocked)}
          />
          <SummaryCard
            label={`${calMonth}월 위기 인원`}
            value={judgementBlocked ? "—" : `${monthTotals.caution.total}명`}
            note={judgementBlocked ? undefined : describeProgress(monthTotals.caution)}
            tone="caution"
            onClick={() => openKpiList("caution", judgementBlocked)}
          />
          <SummaryCard
            label="연락 드린 분"
            value={`${contacted.length}명`}
            tone="safe"
            onClick={openContactedList}
          />
        </div>

        <ResidentListDialog
          open={listDialog !== null}
          onOpenChange={(open) => !open && setListDialog(null)}
          title={listDialog?.title ?? ""}
          entries={listDialog?.entries ?? []}
        />

        {/* 지금 먼저 연락할 분 — 뜻밖인 결석 순. 조기개입 상위만 보이고 나머지는 접어둡니다. */}
        <Card className="mt-6 border-2 border-rose-300 bg-rose-50/40 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-bold text-rose-900">지금 먼저 연락할 분</h2>
            <div className="flex flex-wrap items-center gap-1.5">
              {/* 판정을 멈춘 날에는 이것도 숨깁니다. 배너가 "목록을 비워 두었습니다"라고
                  말하고 KPI 가 「—」인데 옆에 「새로 올라온 12명」이 살아 있으면, 판정을
                  멈춘 목적 그대로 무너집니다. */}
              {!judgementBlocked && newlyEscalatedCount > 0 && (
                <span className="flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
                  <ArrowUpRight className="h-3 w-3" />
                  새로 올라온 {newlyEscalatedCount}명
                </span>
              )}
              {/* 아래 「연락할 분」 칸의 **「남은 N명」과 같은 수**를 씁니다.
                  예전에는 목록 전체 수를 「미확인」이라고 적었습니다. 목록에 이미 연락드린
                  분까지 올리기로 하면서, 한 화면에 「미확인 16명」과 「남은 12명」이 나란히
                  떴습니다. 같은 말이 두 숫자를 가리키면 둘 다 안 믿게 됩니다. */}
              {pendingCount > 0 && (
                <span className="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] font-medium text-stone-600">
                  미확인 {pendingCount}명
                </span>
              )}
              {/* ★ 「조기개입 N명」을 뺐습니다.
                  미확인 18명 옆에 조기개입 18명이 나란히 떠 있었습니다. 둘은 다른 뜻인데
                  (전체 / 그중 아직 확인 못 한 분) 이번 달에 확인한 분이 없으면 값이 같아
                  집니다. 같은 숫자가 두 번 보이면 담당자는 "무슨 차이지"를 생각해야 하고,
                  「조기개입」은 현장 용어도 아닙니다.
                  대신 **확인해서 줄인 수**를 적습니다 — 0명일 때는 숨깁니다. 이쪽이
                  담당자가 오늘 한 일을 보여주는 숫자입니다. */}
              {callAll.length - pendingCount > 0 && (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                  확인해서 뺀 분 {callAll.length - pendingCount}명
                </span>
              )}
            </div>
          </div>
          <p className="mt-1 text-sm text-rose-900/80">
            평소 오시던 분이 안 나오는 순서입니다. 위에서부터 연락하고, 확인한 결과는 각 줄에서 바로
            기록하세요.
          </p>
          <p className="mt-1 rounded-md bg-white/70 px-2.5 py-1.5 text-[11px] leading-relaxed text-stone-600">
            ※ 이 목록은 <b>급식 이용 패턴만</b> 반영합니다. 목록에 없다는 것이 안전을 의미하지
            않습니다.
          </p>

          {/* AI 설명 실행 + 이번 달 비용. 상한을 넘으면 서버가 자동으로 멈춥니다. */}
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-white/60 px-3 py-2">
            <button
              type="button"
              disabled={!session || aiRunning}
              onClick={() => void runAi()}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                aiRunning
                  ? "border-stone-300 bg-stone-100 text-stone-500"
                  : "border-rose-600 bg-rose-600 text-white hover:bg-rose-700"
              } ${!session ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
            >
              {aiRunning
                ? aiProgress
                  ? `AI 설명 쓰는 중… ${aiProgress.done}/${aiProgress.total}명`
                  : "AI 설명 쓰는 중…"
                : aiPending > 0
                  ? `AI 설명 붙이기 (${aiPending}명)`
                  : "AI 설명 붙이기"}
            </button>
            {/* 판정 로직을 고쳤을 때 쓰는 단추입니다.
                AI 문장은 만든 순간의 자료와 설정으로 쓴 글이라 저장된 채 남습니다. 기준선이나
                외부변수를 바꾸면 예전 문장이 낡는데, 기본 단추는 "설명이 있는 분"을 건너뛰므로
                아무리 눌러도 갱신되지 않습니다. 그래서 따로 둡니다 — 돈이 드는 일이라
                눈에 덜 띄게, 누르기 전에 몇 명·얼마인지 묻습니다. */}
            <button
              type="button"
              disabled={!session || aiRunning}
              onClick={() => void runAi(true)}
              className={`rounded-full border border-rose-300 px-2.5 py-1 text-[11px] font-medium text-rose-800 transition hover:bg-rose-50 ${
                !session || aiRunning ? "cursor-not-allowed opacity-50" : "cursor-pointer"
              }`}
              title="판정 로직을 고쳤을 때. 이미 설명이 있는 분까지 전부 새로 만듭니다"
            >
              일괄 갱신
            </button>
            {/* 비용은 원화를 앞에 둡니다.
                "$0.02"는 얼마인지 감이 안 옵니다. 담당자가 알고 싶은 것은 "이번 달에 얼마
                썼고 얼마 남았나"이고, 그건 원화라야 읽힙니다. 달러는 괄호로 함께 적어
                Anthropic 화면과 대조할 수 있게 둡니다. */}
            {aiSpend && (
              <span className="text-[11px] text-rose-800/70">
                이번 달{" "}
                <b className="font-semibold tabular-nums text-rose-900">
                  {Math.round(aiSpend.spent * USD_TO_KRW).toLocaleString()}원
                </b>{" "}
                <span className="text-rose-800/50">(${aiSpend.spent.toFixed(3)})</span> 씀 · 한도{" "}
                <span className="tabular-nums">
                  {Math.round(aiSpend.cap * USD_TO_KRW).toLocaleString()}원
                </span>
                {aiSpend.spent < aiSpend.cap ? (
                  <>
                    {" "}
                    · 남은 금액{" "}
                    <b className="font-semibold tabular-nums text-rose-900">
                      {Math.round((aiSpend.cap - aiSpend.spent) * USD_TO_KRW).toLocaleString()}원
                    </b>
                  </>
                ) : (
                  <b className="ml-1 text-rose-700">· 상한 도달, 자동 중단됨</b>
                )}
              </span>
            )}
            <span className="text-[11px] text-rose-800/50">
              한 분씩 분석 · 이름은 가려서 보냅니다
            </span>
          </div>

          {/* 왼쪽=아직 확인 못 한 분(미연락 + 부재중) · 오른쪽=최근 한 달 확인 기록(최신순). */}
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            {/* ── 왼쪽: 연락할 분 (5명씩 페이지) ── */}
            {/* ★ min-w-0 이 없으면 휴대폰에서 이 카드가 통째로 잘려 안 보였습니다.
                오른쪽 「연락 드린 분」의 메모 미리보기가 truncate(= white-space:nowrap)라
                줄바꿈이 안 되고, 직원이 길게 적은 메모 한 줄의 폭이 그대로 칸의
                최소 너비가 됩니다 — 실제로 751px까지 부풀어 375px 화면에서
                두 칸이 모두 777px가 되고, 바깥의 overflow-hidden 에 잘려 사라졌습니다.
                min-w-0 으로 최소 너비 바닥을 풀어 주면 칸이 화면에 맞게 줄고,
                그제서야 truncate 가 제 일(말줄임)을 합니다.
                넓은 화면에서는 줄일 일이 없어 보이는 것이 달라지지 않습니다. */}
            <div className="min-w-0 rounded-lg border border-rose-200 bg-white/60 p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-sm font-bold text-rose-900">📞 연락할 분</h3>
                {/* 오늘 몇 분이 남았는지가 이 화면에서 가장 자주 보는 수입니다.
                    11px 흐린 글씨로는 제목 옆에 묻혔습니다. */}
                {/* ★ 두 수가 언제나 같았습니다. toContact 가 이미 「정리된 분」을
                    전부 걸러낸 뒤라 done 이 항상 false 이기 때문입니다 —
                    「16명 · 남은 16명」처럼 같은 수를 두 번 적고 있었습니다.
                    여기 있는 분은 전부 오늘 할 일이므로 한 번만 적습니다. */}
                <span className="text-sm font-bold text-rose-900">오늘 {toContact.length}명</span>
              </div>
              {/* ★ 판정을 멈춘 날에 「다 했습니다」가 뜨면 안 됩니다.
                  자료가 덜 들어오면 목록이 비는데, 그때도 같은 문구가 나와
                  **오늘 할 일을 다 한 것처럼** 보였습니다. 경고 배너는 화면 맨 위에
                  있어서 스크롤한 담당자는 👍만 봅니다. 화면이 정반대를 말한 셈입니다. */}
              {toContact.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {judgementBlocked
                    ? "자료가 덜 들어와 오늘은 판정을 멈췄습니다 — 목록이 빈 것이지, 확인할 분이 없는 것이 아닙니다."
                    : "확인 못 한 분이 없습니다. 👍"}
                </p>
              ) : (
                (() => {
                  const PAGE_SIZE = 5;
                  const totalPages = Math.ceil(toContact.length / PAGE_SIZE);
                  const page = Math.min(Math.max(1, worklistPage), totalPages);
                  const start = (page - 1) * PAGE_SIZE;
                  const pageItems = toContact.slice(start, start + PAGE_SIZE);
                  const firstDoneIdx = toContact.findIndex((x) => x.done);
                  return (
                    <>
                      <ul className="space-y-1.5">
                        {pageItems.map((e, i) => {
                          const a = assessments.get(e.resident.id);
                          // 아직 연락 안 한 분과 이미 연락드린 분 사이에 선을 긋습니다.
                          // 목록은 위에서부터 거는 순서라, 어디까지가 「오늘 할 일」인지가
                          // 한눈에 보여야 합니다. 쪽이 넘어가도 한 번만 긋도록 전체 목록에서
                          // 첫 번째 연락드린 분의 자리와 견줍니다.
                          const isDivider = start + i === firstDoneIdx;
                          // ★ 예전에는 여기 null 을 박아 두었습니다.
                          //
                          //   그래서 세 번 전화해도 안 받으신 분과 오늘 처음 뜬 분이
                          //   똑같아 보였습니다. 「연락할 분」은 부재중인 분을 일부러
                          //   남겨두는 목록인데(놓치지 말라고), 정작 **몇 번째 거는
                          //   전화인지가 안 보였습니다.** 담당자는 매번 처음처럼 겁니다.
                          const hist = getFollowupsForResident(e.resident.id).filter(
                            (f) => f.checkedAt <= followupCutoff(assessAtStr),
                          );
                          return (
                            <Fragment key={e.resident.id}>
                              {isDivider && (
                                <li className="flex items-center gap-2 pt-1 text-[11px] font-medium text-stone-400">
                                  <span className="h-px flex-1 bg-stone-200" />
                                  여기부터는 이미 연락드린 분입니다
                                  <span className="h-px flex-1 bg-stone-200" />
                                </li>
                              )}
                              <WorklistRow
                                entry={e}
                                index={start + i + 1}
                                assessment={a}
                                isNew={a ? isNewlyEscalated(e.resident.id, a.level) : false}
                                followup={hist[0] ?? null}
                                followupCount={hist.length}
                                unreachableStreak={
                                  getMemberState(e.resident, assessAtStr).unreachableStreak
                                }
                                asOfStr={assessAtStr}
                                canRecord={!!session}
                                onFollowup={() =>
                                  a && setFollowupTarget({ resident: e.resident, assessment: a })
                                }
                              />
                            </Fragment>
                          );
                        })}
                      </ul>
                      {totalPages > 1 && (
                        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
                          <button
                            type="button"
                            disabled={page <= 1}
                            onClick={() => setWorklistPage(page - 1)}
                            className="rounded-md border border-rose-200 bg-white px-2 py-1 text-xs text-rose-800 hover:bg-rose-100 disabled:opacity-40"
                          >
                            ‹
                          </button>
                          {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setWorklistPage(n)}
                              className={`min-w-7 rounded-md border px-2 py-1 text-xs font-semibold transition ${
                                n === page
                                  ? "border-rose-600 bg-rose-600 text-white"
                                  : "border-rose-200 bg-white text-rose-800 hover:bg-rose-100"
                              }`}
                            >
                              {n}
                            </button>
                          ))}
                          <button
                            type="button"
                            disabled={page >= totalPages}
                            onClick={() => setWorklistPage(page + 1)}
                            className="rounded-md border border-rose-200 bg-white px-2 py-1 text-xs text-rose-800 hover:bg-rose-100 disabled:opacity-40"
                          >
                            ›
                          </button>
                          <span className="ml-1 text-[11px] text-rose-800/60">
                            {start + 1}–{start + pageItems.length} / {toContact.length}
                          </span>
                        </div>
                      )}
                    </>
                  );
                })()
              )}
            </div>

            {/* ── 오른쪽: 연락 드린 분 (최신순) ── */}
            <div className="min-w-0 rounded-lg border border-stone-200 bg-white/60 p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-sm font-bold text-stone-700">✅ 연락 드린 분</h3>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-stone-500">{contacted.length}명</span>
                  {/* 기본은 「도움 필요 먼저」입니다. 이 목록에서 담당자가 다시 찾는 것은
                      방금 적은 기록이 아니라 아직 마무리 안 된 분입니다. */}
                  <select
                    value={contactedSort}
                    onChange={(e) =>
                      setContactedSort(e.target.value as "support" | "recent" | "level")
                    }
                    aria-label="연락 드린 분 정렬"
                    className="rounded-md border border-stone-300 bg-white px-1.5 py-0.5 text-[11px] text-stone-700 transition-colors hover:border-stone-400 focus:border-stone-500 focus:outline-none"
                  >
                    <option value="support">도움 필요 먼저</option>
                    <option value="recent">최신순</option>
                    <option value="level">등급순</option>
                  </select>
                </div>
              </div>
              {contacted.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  아직 확인 기록이 없습니다.
                </p>
              ) : (
                (() => {
                  // ★ 왼쪽과 **줄 수**가 아니라 **높이**를 맞춥니다.
                  //
                  //   예전에는 양쪽 다 5였습니다. 그런데 왼쪽 「연락할 분」은 한 분이
                  //   카드 한 장(판단 근거·배지·달력까지 130px쯤)이고, 오른쪽은 한 줄
                  //   (50px 남짓)입니다. 같은 5를 쓰면 오른쪽 아래가 절반 넘게 비고,
                  //   26건이 있어도 다섯씩 여섯 번을 넘겨야 합니다.
                  //
                  //   왼쪽 다섯 장 ≈ 650px ÷ 오른쪽 한 줄 ≈ 55px → 열두 줄이 들어갑니다.
                  //   왼쪽 카드 모양을 바꾸면 이 숫자도 같이 봐야 합니다.
                  const PAGE_SIZE = 12;
                  const totalPages = Math.max(1, Math.ceil(contacted.length / PAGE_SIZE));
                  const page = Math.min(Math.max(1, contactedPage), totalPages);
                  const start = (page - 1) * PAGE_SIZE;
                  const pageItems = contacted.slice(start, start + PAGE_SIZE);
                  return (
                    <>
                      <ul className="space-y-1.5">
                        {pageItems.map(({ resident, followup }) => (
                          <li key={resident.id}>
                            {/* 이름은 상세로, 나머지 자리는 확인 기록으로.
                          담당자는 여기서 두 가지를 합니다 — 적은 내용을 고치거나, 그분의
                          출결 패턴을 다시 보거나. 줄 전체가 기록 창이면 패턴을 보러 갈 길이
                          없어 위쪽 명단에서 다시 찾아야 했습니다. */}
                            <div className="flex w-full items-center gap-2 rounded-md border border-stone-100 bg-white px-3 py-2 hover:bg-stone-50">
                              <Link
                                to="/resident/$id"
                                params={{ id: resident.id }}
                                className="shrink-0 text-sm font-medium text-foreground hover:underline"
                                title="출결 패턴 보기"
                              >
                                <ResidentName resident={resident} />
                              </Link>
                              <MealTierMark resident={resident} />
                              <ContactedBadge followup={followup} />
                              <button
                                type="button"
                                onClick={() => {
                                  const a =
                                    assessments.get(resident.id) ??
                                    getAiRiskAssessment(resident, assessAt);
                                  setFollowupTarget({ resident, assessment: a });
                                }}
                                className="ml-auto shrink-0 rounded border border-stone-200 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground hover:bg-stone-100"
                                title="확인 기록 보기·고치기"
                              >
                                {followup.checkedAt.slice(5)}
                              </button>
                            </div>
                            {followup.note && (
                              <div className="mt-0.5 truncate px-3 text-[11px] text-muted-foreground">
                                {followup.note.replace("[종결] ", "")}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                      {totalPages > 1 && (
                        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
                          <button
                            type="button"
                            disabled={page <= 1}
                            onClick={() => setContactedPage(page - 1)}
                            className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-100 disabled:opacity-40"
                          >
                            ‹
                          </button>
                          {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setContactedPage(n)}
                              className={`min-w-7 rounded-md border px-2 py-1 text-xs font-semibold transition ${
                                n === page
                                  ? "border-stone-600 bg-stone-600 text-white"
                                  : "border-stone-200 bg-white text-stone-700 hover:bg-stone-100"
                              }`}
                            >
                              {n}
                            </button>
                          ))}
                          <button
                            type="button"
                            disabled={page >= totalPages}
                            onClick={() => setContactedPage(page + 1)}
                            className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-100 disabled:opacity-40"
                          >
                            ›
                          </button>
                          <span className="ml-1 text-[11px] text-muted-foreground">
                            {start + 1}–{Math.min(start + PAGE_SIZE, contacted.length)} /{" "}
                            {contacted.length}
                          </span>
                        </div>
                      )}
                    </>
                  );
                })()
              )}
            </div>
          </div>

          {/* ★ 「잠시 제외」와 「판정을 멈춘 분」을 **한 상자로 합칩니다.**
              두 상자가 사실상 같은 말을 하고 있었습니다 — 실제 화면입니다:

                😌 잠시 제외      홍○동 "너무 더워서 안 나오심… 선선해지면 나오신다고 함"
                ⏸ 판정을 멈춘 분  홍○순 "다음 달부터 다시 오신다고 함"  (일시적 사정·더위)

              같은 더위, 같은 「곧 돌아오심」인데 상자가 갈렸습니다. 가른 것은 담당자의
              판단이 아니라 **갈래(resultKind)를 골랐는지 아닌지**였습니다 — 안 고르면
              안심 기간만 걸려 판정이 계속 돌고, 고르면 판정이 멈춥니다. 그건 구현 사정이지
              담당자가 알아야 할 구분이 아닙니다.

              담당자에게 필요한 것은 하나입니다 — **「이분은 언제 다시 봐야 하나」**.
              그래서 한 상자에 모으고, 돌아오는 방식만 줄 끝에 적습니다. */}
          {acknowledgedFromRecords.snoozed.length + acknowledgedFromRecords.paused.length > 0 && (
            <details className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
              {/* 접어 둡니다. 여기 계신 분들은 이미 사유를 확인해 당분간 볼 일이 없는
                  분들인데, 아홉 줄이 펼쳐진 채로 화면을 차지하면 위에 있는 「연락할 분」이
                  밀려 내려갑니다. 몇 명인지는 접힌 채로도 보이니, 필요할 때만 펴시면 됩니다. */}
              <summary className="flex cursor-pointer list-none items-baseline justify-between">
                <h3 className="text-sm font-bold text-emerald-800">
                  😌 사유를 확인한 분 — 당분간 목록에서 뺍니다 ▾
                </h3>
                <span className="text-[11px] text-emerald-800/70">
                  {acknowledgedFromRecords.snoozed.length + acknowledgedFromRecords.paused.length}명
                </span>
              </summary>
              <p className="mb-2 mt-1.5 text-[11px] leading-relaxed text-emerald-900/70">
                연락해보니 안 나오시는 까닭을 알게 된 분들입니다(여행·가족방문·입원·일자리 참여 등).{" "}
                <b className="font-semibold">그때까지 담당자가 직접 챙기셔야 합니다</b> — 급식
                출결로는 더 볼 것이 없어 계산을 쉬는 중입니다. 줄 끝 날짜 셋은 —{" "}
                <b className="font-semibold">오신다던 날</b>은 어르신·가족이 말씀하신 복귀 시기,{" "}
                <b className="font-semibold">언제까지</b>는 이 날까지 목록에 안 올린다는 우리 쪽
                약속, <b className="font-semibold">적은 날</b>은 담당자가 기록한 날입니다(누르면
                기록을 고칠 수 있습니다).{" "}
                <b className="font-semibold">
                  오신다던 날이 지났는데 아직 안 나오시면 그것이 신호입니다.
                </b>
              </p>
              {/* 머리줄. 칸이 넷인데 이름표가 없어서, 가운데 파란 표가 무엇을 뜻하는지
                  (확인된 사유인지 등급인지) 화면만 봐서는 알 수 없었습니다.
                  좁은 화면에서는 칸 너비가 어차피 안 맞으니 감춥니다. */}
              <div className="mb-1 hidden w-full items-center gap-2 px-3 text-[10px] font-semibold uppercase tracking-wide text-emerald-900/55 sm:flex">
                <span className="w-[11.5rem] shrink-0">어르신 · 회원번호</span>
                <span className="w-[9.5rem] shrink-0">확인된 사유</span>
                <span className="min-w-0 flex-1">적어 두신 내용</span>
                {/* 날짜 셋은 서로 다른 것을 말합니다. 줄마다 「오신다던 날 10-02」처럼
                    이름표를 달아 뒀더니 줄이 길어지고 같은 말이 열여덟 번 반복됐습니다.
                    이름은 머리줄에 한 번만 두고, 줄에는 날짜만 둡니다. */}
                <span className="w-[4.5rem] shrink-0 text-center">오신다던 날</span>
                <span className="w-[6.5rem] shrink-0 text-center">언제까지</span>
                <span className="w-[3.5rem] shrink-0 text-center">적은 날</span>
              </div>
              <ul className="space-y-1.5">
                {[
                  ...acknowledgedFromRecords.paused.map((x) => ({ ...x, kind: "paused" as const })),
                  ...acknowledgedFromRecords.snoozed.map((x) => ({
                    ...x,
                    kind: "snoozed" as const,
                  })),
                ].map(({ resident, followup, kind }) => (
                  <li key={resident.id}>
                    <div className="flex w-full items-center gap-2 rounded-md border border-emerald-100 bg-white px-3 py-1.5 hover:bg-emerald-50">
                      {/* 머리줄과 같은 너비를 씁니다. 이 숫자가 어긋나면 이름표가
                          엉뚱한 칸을 가리킵니다 — 바꿀 때 위 머리줄도 함께 고치세요. */}
                      <span className="flex shrink-0 items-center gap-1.5 sm:w-[11.5rem]">
                        <Link
                          to="/resident/$id"
                          params={{ id: resident.id }}
                          className="text-sm font-medium text-foreground hover:underline"
                          title="출결 패턴 보기"
                        >
                          <ResidentName resident={resident} />
                        </Link>
                        <MealTierMark resident={resident} />
                      </span>
                      <span className="shrink-0 sm:w-[9.5rem]">
                        {followup.resultKind && (
                          <span className="inline-block rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-800">
                            {RESULT_KIND_META[followup.resultKind]?.label ?? followup.resultKind}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {followup.note ? `· ${followup.note}` : ""}
                      </span>
                      {/* 돌아오는 방식이 둘뿐입니다 — 날짜가 되면, 또는 다시 나오시면.
                          담당자가 알아야 할 것은 이것 하나입니다. */}
                      {/* 언제 돌아오는지를 적습니다. 기한을 직접 정하셨으면 그 날,
                          안 정하셨으면 기본 기한(recheckDueDate)이 잡은 날입니다.
                          「다시 나오시면」은 급식에 나오셔야 풀리는 보류 갈래에만 씁니다 —
                          예전에는 기한이 없으면 무조건 이 말을 적어서, 날짜가 정해져 있는
                          분께도 "언제 올라오는지 모름"처럼 보였습니다. */}
                      {/* ★ 날짜 세 개가 서로 다른 것을 말합니다. 라벨 없이 숫자만 두면
                          담당자가 어느 것이 무엇인지 알 수 없습니다 —

                            적은 날    담당자가 통화하고 기록한 날
                            오신다던 날 어르신·가족이 "이때쯤 나오겠다"고 하신 날
                            ~까지      이 날까지는 목록에 안 올린다는 우리 쪽 약속

                          「오신다던 날」이 지났는데 아직 안 나오시면 그게 신호입니다.
                          그러니 그 날짜가 화면에 있어야 합니다. */}
                      <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] tabular-nums">
                        <span
                          className="w-[4.5rem] shrink-0 text-center"
                          title="어르신·가족이 이때쯤 나오시겠다고 하신 날. 이 날이 지났는데 아직 안 나오시면 그것이 신호입니다"
                        >
                          {followup.resumeExpected ? (
                            <span className="inline-block rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900">
                              {followup.resumeExpected.slice(5)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </span>
                        <span
                          className="w-[6.5rem] shrink-0 text-center"
                          title="이 날까지는 목록에 올리지 않습니다"
                        >
                          <span className="inline-block rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-900">
                            {kind === "snoozed"
                              ? `~${(followup.snoozeUntil ?? recheckDueDate(followup) ?? "").slice(5)}`
                              : "다시 나오시면"}
                          </span>
                        </span>
                        <span className="w-[3.5rem] shrink-0 text-center">
                          <button
                            type="button"
                            onClick={() => {
                              const a =
                                assessments.get(resident.id) ??
                                getAiRiskAssessment(resident, assessAt);
                              setFollowupTarget({ resident, assessment: a });
                            }}
                            className="rounded border border-stone-200 px-1.5 py-0.5 font-medium text-stone-600 hover:bg-stone-100"
                            title="확인 기록 보기·고치기"
                          >
                            {followup.checkedAt.slice(5)}
                          </button>
                        </span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* 사례 관리 종료 — 잠시가 아니라 완전히 빠진 분들. 접어 둡니다. */}
          {acknowledgedFromRecords.closed.length > 0 && (
            <details className="mt-2 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
              <summary className="cursor-pointer list-none text-sm font-bold text-stone-600">
                ⚫ 사례 관리 종료 {acknowledgedFromRecords.closed.length}명 (사망·이사·요양원 등) ▾
              </summary>
              <p className="mt-1 mb-2 text-[11px] leading-relaxed text-stone-500">
                급식으로는 더 볼 수 없게 된 분들입니다. <b>자동으로 다시 뜨지 않습니다.</b> 잘못
                종결했다면 이름 옆 날짜를 눌러 기록을 고치면 목록으로 돌아옵니다.
              </p>
              <ul className="space-y-1">
                {acknowledgedFromRecords.closed.map(({ resident, followup }) => (
                  <li
                    key={resident.id}
                    className="flex items-center gap-2 rounded border border-stone-200 bg-white px-3 py-1.5 text-xs"
                  >
                    <Link
                      to="/resident/$id"
                      params={{ id: resident.id }}
                      className="shrink-0 font-medium hover:underline"
                    >
                      <ResidentName resident={resident} />
                    </Link>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {followup.note.replace("[종결] ", "· ")}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const a =
                          assessments.get(resident.id) ?? getAiRiskAssessment(resident, assessAt);
                        setFollowupTarget({ resident, assessment: a });
                      }}
                      className="ml-auto shrink-0 rounded border border-stone-200 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground hover:bg-stone-100"
                      title="확인 기록 보기·고치기"
                    >
                      {followup.checkedAt.slice(5)}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* 「🟢 관찰 N명 — 급식에 오시면 자동으로 빠집니다」 상자를 뺐습니다.

              이분들은 **담당자가 할 일이 없는 분들**이었습니다. 확인 버튼도 없고, 급식에
              오시면 알아서 목록에서 빠집니다. 그런데도 대시보드 아래에 열일곱 줄로 서 있어서,
              전화를 걸다 말고 눈이 갑니다. 아무것도 안 해도 되는 목록이 화면에 있으면
              "저건 뭐지"를 매번 다시 판단해야 합니다.

              계산에서 뺀 것이 아닙니다 — worklist.observe 는 그대로 있고, 이분들이 더 안
              나오시면 등급이 올라 위 「연락할 분」에 뜹니다. 지금은 그때까지 조용히 둡니다. */}

          {/* '확인됨·안심·종결'은 위 오른쪽 '연락 드린 분' 목록에서 최신순으로 함께 봅니다. */}

          {/* 하락(월간 검토) — 절벽과 별개 통로. 서서히 줄어드는 분(끊기기 훨씬 전에 잡힘). */}
          {/* 약속한 복귀일이 지난 분 (구현요청서 9-4) — 점수와 무관하게 따로 올립니다.
              긴 결석으로 기준선이 무너지면 오히려 "판단 어려움"로 조용히 내려가기 때문입니다. */}
          {resumeOverdue.length > 0 && (
            <div className="mt-6 rounded-lg border-2 border-violet-300 bg-violet-50 p-4">
              <h2 className="text-sm font-bold text-violet-900">
                📅 나오신다고 하신 날이 지났습니다 — {resumeOverdue.length}명
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-violet-900/80">
                확인 기록에 적어둔 <b>복귀 예정일</b>이 지났는데 아직 안 나오십니다. 그때는 사정이
                있다고 하셨지만, 약속한 날이 지나도 안 나오시는 것은 다시 봐야 할 신호입니다.
              </p>
              <ul className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
                {resumeOverdue.map(({ resident, promised }) => (
                  <li key={resident.id}>
                    <Link
                      to="/resident/$id"
                      params={{ id: resident.id }}
                      className="flex items-center gap-2 rounded-md border border-violet-200 bg-white px-3 py-2 text-sm hover:bg-violet-50"
                    >
                      <span className="font-semibold">{residentLabel(resident)}</span>
                      <span className="ml-auto text-xs font-medium tabular-nums text-violet-800">
                        {promised ? `${promised.slice(5)} 예정이었음` : "복귀 예정일 지남"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 방문 확인 대상 (구현요청서 9-2) — 전화가 세 번 연달아 안 되면 전화로는 안 됩니다.
              연락이 안 되는 것 자체가 신호라, 목록에서 빼지 않고 오히려 올려서 보여줍니다. */}
          {visitNeeded.length > 0 && (
            <div className="mt-6 rounded-lg border-2 border-red-300 bg-red-50 p-4">
              <h2 className="text-sm font-bold text-red-900">
                🚪 방문 확인이 필요합니다 — {visitNeeded.length}명
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-red-900/80">
                연락이 <b>세 번 이상 연달아</b> 닿지 않은 분입니다. 전화로는 확인이 안 되니 직접
                찾아뵙는 것이 맞습니다. 연락이 안 되는 것 자체가 신호입니다.
              </p>
              <ul className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
                {visitNeeded.map(({ resident, tries }) => (
                  <li key={resident.id}>
                    <Link
                      to="/resident/$id"
                      params={{ id: resident.id }}
                      className="flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm hover:bg-red-50"
                    >
                      <span className="font-semibold">{residentLabel(resident)}</span>
                      <span className="text-xs text-muted-foreground">{resident.id}</span>
                      <span className="ml-auto text-xs font-medium text-red-700">
                        연락 실패 {tries}회
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 기준선 하향 이력 (9-5) — 절벽 점수로는 잡히지 않는 쇠약의 궤적입니다. */}
          {repeatedDowngrades.length > 0 && (
            <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <h2 className="text-sm font-bold text-amber-900">
                📉 지속적으로 이용이 줄고 있습니다 — {repeatedDowngrades.length}명
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-amber-900/80">
                최근 6개월 안에 &lsquo;덜 오시게 됨&rsquo;으로 <b>두 번 이상</b> 기록된 분입니다. 한
                번은 사정이 있을 수 있지만 반복되는 하락은 쇠약의 궤적입니다.
              </p>
              <ul className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
                {repeatedDowngrades.map(({ resident, count }) => (
                  <li key={resident.id}>
                    <Link
                      to="/resident/$id"
                      params={{ id: resident.id }}
                      className="flex items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-2 text-sm hover:bg-amber-50"
                    >
                      <span className="font-semibold">{residentLabel(resident)}</span>
                      <span className="ml-auto text-xs font-medium text-amber-800">{count}회</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {worklist.declineList.length > 0 && (
            <details className="mt-3 border-t border-rose-200 pt-3">
              <summary className="cursor-pointer list-none text-sm font-medium text-violet-700 hover:text-violet-900">
                📉 서서히 줄고 있는 분 {worklist.declineList.length}명 — 월간 검토 ▾
              </summary>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                완전히 끊기기 전, 오는 횟수가 서서히 줄고 있는 분들입니다. 절벽(연속결석)으로는 안
                잡혀서 따로 봅니다. 월 1회 훑어보세요.
              </p>
              <ul className="mt-2 space-y-1.5">
                {worklist.declineList.map((e) => (
                  <li key={e.resident.id}>
                    <Link
                      to="/resident/$id"
                      params={{ id: e.resident.id }}
                      className="block rounded-md border border-stone-100 px-3 py-2 hover:bg-stone-50"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          <ResidentName resident={e.resident} />
                        </span>
                        <MealTierMark resident={e.resident} />
                        <span className="ml-auto text-xs text-muted-foreground">
                          최근 {e.recentRate}%
                        </span>
                      </div>
                      <div className="mt-1 text-sm leading-relaxed text-foreground/80">
                        {worklistReason(e)}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>

        {/* 확인 기록은 **적은 날**로 남깁니다. 자료 기준일이 아닙니다 —
            어제 자료를 오늘 보고, 오늘 전화하고, 오늘 적으니까요. */}
        <FollowupDialog
          target={followupTarget}
          onClose={() => setFollowupTarget(null)}
          checkedAt={recordDateFor(assessAtStr)}
          dataAsOf={attendanceRefDate ?? DATA_END_STR}
          canRecord={!!session}
        />
      </main>
    </div>
  );
}
