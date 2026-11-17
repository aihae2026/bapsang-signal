import { ResidentName, residentSubtitle } from "@/components/ResidentName";
import { useMemo, useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
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
import { RiskBadge } from "@/components/RiskBadge";
import {
  RISK_LABELS,
  RISK_ORDER,
  getActiveResidents,
  getAiRiskAssessment,
  getLastAttendanceDate,
  useDataVersion,
  type RiskLevel,
} from "@/lib/attendance-engine";

export const Route = createFileRoute("/pattern-analysis")({
  // 이 화면은 관리자 설정 안의 탭과 **같은 내용**입니다. 두 곳에 두면 한쪽만 고쳐져
  // 서로 다른 말을 하게 됩니다. 예전 주소·북마크는 살려두고 탭으로 넘깁니다.
  beforeLoad: () => {
    throw redirect({ to: "/admin", search: { tab: "pattern" } });
  },
  head: () => ({
    meta: [
      { title: "개인별 출결 패턴 분석 | 밥상위의 신호" },
      {
        name: "description",
        content: "어르신 개개인의 출석 패턴을 AI가 분석한 내용을 한 명씩 확인합니다.",
      },
    ],
  }),
  component: PatternAnalysisPage,
});

const SEVERITY_ORDER: Record<RiskLevel, number> = {
  crisis: 0,
  caution: 1,
  concern: 2,
  normal: 3,
  // 판단하지 않은 분은 맨 아래. 위에서부터 읽는 목록이라, 판단한 분이 먼저여야 합니다.
  unknown: 4,
};

export function PatternAnalysisPanel() {
  const version = useDataVersion();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<RiskLevel | "all">("all");
  // 기본은 **최신 방문순** — 최근에 다녀가신 분부터 보이는 게 현황 파악에 자연스럽습니다.
  // 위험도순은 "누구부터 연락하나"를 볼 때 씁니다.
  // 기본은 **위험도순**입니다. 이 화면을 여는 이유가 "누구를 먼저 봐야 하나"이므로
  // 가장 먼저 보이는 줄이 가장 급한 분이어야 합니다. 최신 방문순은 "요즘 누가 오셨나"를
  // 볼 때 쓰는 것이라 두 번째입니다.
  const [sort, setSort] = useState<"recent" | "risk" | "name">("risk");

  const entries = useMemo(() => {
    return getActiveResidents()
      .map((resident) => ({
        resident,
        assessment: getAiRiskAssessment(resident),
        lastAttendance: getLastAttendanceDate(resident),
      }))
      .filter((e) => (filter === "all" ? true : e.assessment.level === filter))
      .filter((e) => e.resident.name.toLowerCase().includes(search.trim().toLowerCase()))
      .sort((a, b) => {
        if (sort === "recent") {
          // 최근 방문이 늦은 사람이 앞. 기록이 없는 분은 맨 뒤로 보냅니다.
          const av = a.lastAttendance ?? "";
          const bv = b.lastAttendance ?? "";
          if (av !== bv) return bv.localeCompare(av);
          return SEVERITY_ORDER[a.assessment.level] - SEVERITY_ORDER[b.assessment.level];
        }
        if (sort === "name") return a.resident.name.localeCompare(b.resident.name);
        return (
          SEVERITY_ORDER[a.assessment.level] - SEVERITY_ORDER[b.assessment.level] ||
          a.assessment.attendanceRate - b.assessment.attendanceRate
        );
      });
  }, [search, filter, sort, version]);

  return (
    <>
      <div className="mb-4">
        <p className="text-sm text-muted-foreground">
          출석 체크 데이터를 기반으로 어르신 한 분 한 분의 평소 패턴 대비 최근 변화를 AI가 분석한
          내용입니다. 위험군 리포트와 달리 정상 판정을 포함한 전체 {getActiveResidents().length}
          명을 확인할 수 있습니다.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          placeholder="이름으로 검색 (예: 김순자)"
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
        <Select value={sort} onValueChange={(v) => setSort(v as "recent" | "risk" | "name")}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="정렬" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="risk">위험도순</SelectItem>
            <SelectItem value="recent">최신 방문순</SelectItem>
            <SelectItem value="name">이름순</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{entries.length}명 표시 중</span>
      </div>

      <div className="space-y-3">
        {entries.map(({ resident, assessment, lastAttendance }) => (
          <Card key={resident.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <ResidentAvatar seed={resident.id} photoUrl={resident.photoUrl} size={40} />
                <div>
                  <div className="flex items-center gap-2">
                    <Link
                      to="/resident/$id"
                      params={{ id: resident.id }}
                      className="text-sm font-semibold text-foreground hover:underline"
                    >
                      <ResidentName resident={resident} />
                    </Link>
                    {/* 사유를 확인해 잠시 빼둔 분은 level 이 normal 로 내려갑니다.
                        대시보드·연계 의뢰서는 levelBeforeSnooze 를 그리는데 여기만
                        level 을 그려, 같은 어르신이 화면마다 다르게 불렸습니다. */}
                    <RiskBadge level={assessment.levelBeforeSnooze ?? assessment.level} />
                    {assessment.patternBreak && (
                      <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                        평소와 다른 변화 감지
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {residentSubtitle(resident)}
                  </div>
                </div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div>이번 달 출석률 {assessment.attendanceRate}%</div>
                {assessment.consecutiveAbsence > 0 && (
                  <div className="font-medium text-red-600">
                    연속결석 {assessment.consecutiveAbsence}일
                  </div>
                )}
                <div>최근 출석일 {lastAttendance ?? "기록 없음"}</div>
              </div>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-foreground">{assessment.narrative}</p>
            {assessment.reasons.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {assessment.reasons.map((reason, i) => (
                  <span
                    key={i}
                    className="rounded-full border border-stone-200 bg-white px-2.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {reason}
                  </span>
                ))}
              </div>
            )}
          </Card>
        ))}
        {entries.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            조건에 맞는 어르신이 없습니다.
          </p>
        )}
      </div>
    </>
  );
}

// 주소로 직접 들어온 경우를 위한 독립 페이지. 평소에는 관리자 설정 안의 탭으로 봅니다.
function PatternAnalysisPage() {
  return (
    <div className="min-h-screen bg-stone-50">
      <NavBar />
      <main className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">개인별 출결 패턴 분석</h1>
        </div>
        <PatternAnalysisPanel />
      </main>
    </div>
  );
}
