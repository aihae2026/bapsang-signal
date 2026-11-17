import { ResidentName, residentSubtitle, MealTierMark } from "@/components/ResidentName";
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NavBar } from "@/components/NavBar";
import { ResidentAvatar } from "@/components/ResidentAvatar";
import {
  DATA_END_STR,
  realTodayStr,
  RISK_LABELS,
  RISK_ORDER,
  getAiOneLiner,
  getAiRiskAssessment,
  getCurrentRisk,
  getDisplayStatus,
  residents,
  useDataVersion,
  type AiRiskAssessment,
  type Resident,
  type ResidentStatus,
  type RiskLevel,
  getLongAbsenceBoundary,
} from "@/lib/attendance-engine";

import { FollowupDialog } from "@/components/FollowupDialog";
import { useSession } from "@/lib/use-session";
import { Button } from "@/components/ui/button";
import { PhoneCall } from "lucide-react";

export const Route = createFileRoute("/members")({
  // 상단 메뉴의 「회원관리」가 이 화면입니다.
  //
  // 예전에는 관리자 설정 안의 탭으로 넘겼습니다(같은 내용을 두 곳에 두지 않으려고).
  // 이제 탭 쪽을 없애고 이 화면 하나만 남깁니다 — 어르신 한 분을 찾는 일은 「설정」이
  // 아니라 매일 하는 일이라, 상단에서 바로 닿는 편이 맞습니다.
  head: () => ({
    meta: [
      { title: "회원관리 | 밥상위의 신호" },
      {
        name: "description",
        content: "어르신 목록을 검색·필터링하고 출석률과 최근 상태를 확인합니다.",
      },
    ],
  }),
  component: MembersPage,
});

const STATUS_LABELS: Record<ResidentStatus, string> = { active: "활동중", discharged: "퇴소" };
const STATUS_BADGE_STYLES: Record<ResidentStatus, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-700",
  discharged: "border-stone-200 bg-stone-100 text-stone-500",
};

/**
 * 「등급」 칸에 실제로 찍히는 말의 차례.
 *
 * 예전에는 위험도(RiskLevel)로만 줄을 세웠습니다. 그런데 화면에 보이는 것은 위험도가 아니라
 * getDisplayStatus 가 내는 말(판단 어려움·자료 부족·복귀 관찰…)이라, 줄은 줄대로 서 있는데
 * **보이는 순서는 뒤죽박죽**이었습니다. 특히 「판단 어려움」이 위기와 정상 사이에 섞여 들어갔습니다.
 *
 * 「판단 어려움」은 「급식 기록만으로는 판단할 수 없는 분」입니다. 담당자가 이 목록을 위에서부터
 * 읽는다면, 판단할 수 없는 분이 판단된 분보다 먼저 나올 이유가 없습니다. 맨 아래로 내립니다.
 */
const STATUS_RANK: Record<string, number> = {
  // ★ 등급 이름이 바뀌면 이 표도 함께 바뀌어야 합니다.
  //    「긴급」이 키에 없어 ?? 99 로 떨어지는 바람에, 가장 급한 분이 종결(8)보다도
  //    아래 — 목록 맨 끝으로 밀려 있었습니다. 동시에 위기(옛 주의)가 맨 위로 올라왔습니다.
  긴급: 0,
  위기: 1,
  관심: 2,
  정상: 3,
  "복귀 관찰": 4,
  "자료 부족": 5,
  "판단 어려움": 6,
  보류: 7,
  종결: 8,
};
const rankOf = (label: string) => STATUS_RANK[label] ?? 99;

/**
 * 가려 놓은 이름을 풀네임으로 찾습니다.
 *
 * 이름은 홍○동 꼴로만 보관합니다(개인정보). 그래서 담당자가 아는 대로 「홍길녀」를 치면
 * 한 명도 안 나왔습니다 — 가운뎃점이 글자와 안 맞으니까요. 찾는 사람 머릿속에 있는 것은
 * 늘 풀네임인데 화면은 가린 이름만 아는, 앞뒤가 안 맞는 상황이었습니다.
 *
 * ○ 를 **아무 글자나 된다는 뜻**으로 보고 한 칸씩 맞춰 봅니다. 글자 수가 같아야 하므로
 * 「김자」로 「김○자」가 걸리지는 않습니다.
 */
function maskedNameMatches(masked: string, query: string): boolean {
  if (masked.length !== query.length) return false;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "○" && masked[i] !== query[i]) return false;
  }
  return true;
}

/**
 * 연속 결석일.
 *
 * 「9월 출석률 40%」는 달이 바뀌면 뜻이 달라집니다 — 월초에는 이틀만 빠져도 0%가 되고,
 * 월말에는 보름을 안 나오셔도 50%로 보입니다. 담당자가 알고 싶은 것은 **지금 며칠째인가**
 * 하나이고, 그건 달과 상관없이 늘 같은 뜻입니다.
 *
 * 0일은 숫자로 쓰지 않습니다. 한 화면에 0이 수백 개면 눈이 숫자를 걸러내지 못합니다.
 */
function AbsenceDays({ days }: { days: number }) {
  if (days <= 0) return <span className="text-sm text-muted-foreground">—</span>;
  const long = days > getLongAbsenceBoundary();
  return (
    <span
      className={`text-sm tabular-nums ${long ? "font-semibold text-red-700" : "text-foreground"}`}
    >
      {days}일
    </span>
  );
}

export function MembersPanel() {
  const version = useDataVersion();
  const session = useSession();
  // 여기서 바로 확인 기록을 남깁니다.
  //
  // 지금까지는 위기로 뜬 분의 이름을 눌러 상세로 들어가 패턴을 보고, 연락드린 뒤 다시
  // 대시보드로 돌아와 기록해야 했습니다. 목록을 훑으며 여러 분께 연이어 전화하는 일이
  // 실제 업무인데, 한 분마다 화면을 세 번 옮겨야 했던 셈입니다.
  const [followupTarget, setFollowupTarget] = useState<{
    resident: Resident;
    assessment: AiRiskAssessment;
  } | null>(null);
  const openFollowup = (resident: Resident) =>
    setFollowupTarget({ resident, assessment: getAiRiskAssessment(resident) });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<RiskLevel | "all">("all");
  const [statusFilter, setStatusFilter] = useState<ResidentStatus | "all">("active");

  const rows = useMemo(() => {
    return residents
      .map((r) => ({
        resident: r,
        risk: getCurrentRisk(r),
        status: getDisplayStatus(r),
        absence: getAiRiskAssessment(r).consecutiveAbsence,
      }))
      .filter((row) => (filter === "all" ? true : row.risk.level === filter))
      .filter((row) => (statusFilter === "all" ? true : row.resident.status === statusFilter))
      .filter((row) => {
        // 회원번호로도 찾을 수 있어야 합니다. 이름을 가려서 저장하기 때문에(김○자)
        // 이름만으로는 여러 분이 걸립니다.
        const q = search.trim();
        if (!q) return true;
        const name = row.resident.name;
        return (
          name.toLowerCase().includes(q.toLowerCase()) ||
          maskedNameMatches(name, q) ||
          row.resident.id.toLowerCase().includes(q.toLowerCase())
        );
      })
      .sort(
        (a, b) =>
          // 보이는 등급 차례대로. 같은 등급 안에서는 오래 안 나오신 분이 위로 옵니다.
          rankOf(a.status.label) - rankOf(b.status.label) || b.absence - a.absence,
      );
  }, [search, filter, statusFilter, version]);

  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">
        전체 {residents.length}명 중 {rows.length}명 표시 중입니다.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          placeholder="이름 또는 회원번호로 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={filter} onValueChange={(v) => setFilter(v as RiskLevel | "all")}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="등급 필터" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 등급</SelectItem>
            {RISK_ORDER.map((level) => (
              <SelectItem key={level} value={level}>
                {RISK_LABELS[level]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as ResidentStatus | "all")}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="상태 필터" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">활동중만</SelectItem>
            <SelectItem value="discharged">퇴소만</SelectItem>
            <SelectItem value="all">전체 상태</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 데스크톱/태블릿: 표 형태 */}
      <Card className="hidden overflow-x-auto p-0 sm:block">
        <table className="w-full min-w-[960px] text-sm">
          <thead>
            <tr className="border-b bg-stone-50 text-left text-xs text-muted-foreground">
              <th className="px-4 py-3 font-medium">이름</th>
              <th className="px-4 py-3 font-medium">상태</th>
              <th className="px-4 py-3 font-medium">등급</th>
              <th
                className="px-4 py-3 font-medium"
                title="문 연 날만 셉니다. 공휴일·휴관일은 뺍니다"
              >
                연속 결석일
              </th>
              <th
                className="px-4 py-3 font-medium"
                title="AI는 등급을 정하지 않습니다. 계산 결과를 문장으로 옮길 뿐입니다"
              >
                AI 설명
              </th>
              <th className="px-4 py-3 font-medium">특이사항</th>
              <th className="px-4 py-3 font-medium">확인</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ resident, status, absence }) => (
              <tr key={resident.id} className="border-b last:border-0 hover:bg-stone-50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <ResidentAvatar seed={resident.id} photoUrl={resident.photoUrl} size={32} />
                    <div>
                      <Link
                        to="/resident/$id"
                        params={{ id: resident.id }}
                        className="font-medium text-foreground hover:underline"
                      >
                        <ResidentName resident={resident} />
                        <MealTierMark resident={resident} />
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {residentSubtitle(resident)}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${STATUS_BADGE_STYLES[resident.status]}`}
                  >
                    {STATUS_LABELS[resident.status]}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {/* 등급만 쓰면 225일 연락 없는 분이 "정상"으로 나옵니다 —
                        판단 어려움·보류·종결을 함께 보여줍니다. */}
                  <span
                    title={status.hint}
                    className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${status.style}`}
                  >
                    {status.label}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <AbsenceDays days={absence} />
                </td>
                <td className="max-w-56 px-4 py-3 text-xs text-muted-foreground">
                  {getAiOneLiner(resident)}
                </td>
                <td className="max-w-48 px-4 py-3 text-xs text-muted-foreground">
                  {resident.notes}
                </td>
                <td className="px-4 py-3">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 whitespace-nowrap px-2 text-xs"
                    onClick={() => openFollowup(resident)}
                  >
                    <PhoneCall className="mr-1 h-3 w-3" />
                    확인 기록
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  조건에 맞는 어르신이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* 모바일: 카드 형태 (가로 스크롤 없이 세로로 쌓아서 보여줌) */}
      <div className="space-y-3 sm:hidden">
        {rows.map(({ resident, status, absence }) => (
          <Card key={resident.id} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <Link
                to="/resident/$id"
                params={{ id: resident.id }}
                className="flex items-center gap-2.5"
              >
                <ResidentAvatar seed={resident.id} photoUrl={resident.photoUrl} size={36} />
                <div>
                  <div className="font-medium text-foreground hover:underline">
                    <ResidentName resident={resident} />
                  </div>
                  <div className="text-xs text-muted-foreground">{residentSubtitle(resident)}</div>
                </div>
              </Link>
              <div className="flex flex-col items-end gap-1">
                <span
                  title={status.hint}
                  className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${status.style}`}
                >
                  {status.label}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${STATUS_BADGE_STYLES[resident.status]}`}
                >
                  {STATUS_LABELS[resident.status]}
                </span>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="flex items-baseline gap-1.5">
                <span className="text-xs text-muted-foreground">연속 결석</span>
                <AbsenceDays days={absence} />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => openFollowup(resident)}
              >
                <PhoneCall className="mr-1 h-3 w-3" />
                확인 기록
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{getAiOneLiner(resident)}</p>
            {resident.notes && (
              <p className="mt-1 text-xs text-muted-foreground">특이사항: {resident.notes}</p>
            )}
          </Card>
        ))}
        {rows.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            조건에 맞는 어르신이 없습니다.
          </p>
        )}
      </div>

      <FollowupDialog
        target={followupTarget}
        onClose={() => setFollowupTarget(null)}
        checkedAt={realTodayStr()}
        dataAsOf={DATA_END_STR}
        canRecord={!!session}
      />
    </>
  );
}

// 상단 메뉴 「회원관리」가 여는 화면입니다. 관리자 설정 안의 탭은 없앴습니다.
function MembersPage() {
  return (
    <div className="min-h-screen bg-stone-50">
      <NavBar />
      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">회원관리</h1>
        </div>
        <MembersPanel />
      </main>
    </div>
  );
}
