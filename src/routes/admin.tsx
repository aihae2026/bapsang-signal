import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PatternAnalysisPanel } from "./pattern-analysis";
import { listImportLogs, listRecentResidents, type ImportLog } from "@/lib/encom-import";
import {
  getDataFreshness,
  getDataIssues,
  getFactorImpact,
  setDataIssueChecked,
  setResidentStatus as setStatusForIssue,
  type DataIssue,
} from "@/lib/attendance-engine";
import { useStaffName as useStaffNameForIssue } from "@/lib/use-session";
import { Check } from "lucide-react";
import { listMenuEvents, setMenuEvent } from "@/lib/menus";

/**
 * 자료 점검 — 손봐야 할 기록을 모아 보여줍니다.
 *
 * 자료는 엑셀에서 들어오고 엑셀은 사람이 뽑습니다. 열이 밀리거나 빈 칸이 생기는 일은
 * 반드시 일어납니다. 중요한 것은 **그게 일어났을 때 눈에 띄는가**입니다.
 *
 * 실제로 회원번호 자리에 날짜가 들어간 기록이 생겼는데, 어느 화면에도 표시가 없어
 * 우연히 발견했습니다. 그런 분은 위기로 떠도 엔컴에서 조회할 수 없어 담당자가 확인할
 * 방법이 없습니다. 그래서 판정에서는 빼되, 이 자리에는 크게 띄웁니다 — 조용히 빼기만
 * 하면 아무도 고치지 않습니다.
 */
function DataIssueSection() {
  const version = useDataVersion();
  const staffName = useStaffNameForIssue();
  const all = useMemo(() => getDataIssues(), [version]);
  const [showChecked, setShowChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const open = all.filter((i) => !i.checked);
  const done = all.filter((i) => i.checked);
  const blocking = open.filter((i) => i.severity === "blocking");
  const warn = open.filter((i) => i.severity === "warn");

  const check = async (i: DataIssue, next: boolean) => {
    const key = `${i.residentId}::${i.kind}`;
    setBusy(key);
    const res = await setDataIssueChecked(i.residentId, i.kind, next, staffName);
    setBusy(null);
    if (!res.ok) return void toast.error(`저장하지 못했습니다 — ${res.error}`);
    toast.success(next ? "확인한 것으로 접어두었습니다." : "다시 목록에 올렸습니다.");
  };

  // 회원번호가 깨진 기록은 고칠 방법이 둘뿐입니다 — 원본에서 진짜 번호를 찾아 살리거나,
  // 지워도 되는 줄이면 명부에서 빼거나. 화면에서 할 수 있는 것은 뒤쪽입니다.
  const removeFromRoster = async (i: DataIssue) => {
    if (
      !window.confirm(
        `'${i.name}' 기록을 명부에서 뺄까요?\n\n` +
          `판정과 통계에서 제외됩니다. 자료가 지워지는 것은 아니고, 회원관리 탭에서 언제든 되돌릴 수 있습니다.`,
      )
    )
      return;
    setBusy(`${i.residentId}::${i.kind}`);
    setStatusForIssue(i.residentId, "discharged");
    setBusy(null);
    toast.success("명부에서 뺐습니다.");
  };

  const Row = ({ i }: { i: DataIssue }) => {
    const key = `${i.residentId}::${i.kind}`;
    return (
      <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border bg-white px-3 py-2 text-sm">
        <span className="font-medium text-foreground">{i.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{i.residentId.slice(0, 40)}</span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            i.severity === "blocking"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          {i.kind}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {i.checked ? (
            <>
              <span className="text-[11px] text-muted-foreground">
                {i.checkedBy || "누군가"} · {i.checkedAt}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={busy === key}
                onClick={() => void check(i, false)}
              >
                되돌리기
              </Button>
            </>
          ) : (
            <>
              {i.severity === "blocking" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                  disabled={busy === key}
                  onClick={() => void removeFromRoster(i)}
                >
                  명부에서 빼기
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={busy === key}
                onClick={() => void check(i, true)}
              >
                <Check className="mr-1 h-3 w-3" />
                확인했습니다
              </Button>
            </>
          )}
        </span>

        <span className="w-full text-xs text-muted-foreground">{i.detail}</span>
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold">판정에서 빠진 기록 {blocking.length}건</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            회원번호나 이름이 성하지 않아 <b className="text-foreground">누구인지 확인할 수 없는</b>{" "}
            기록입니다. 위기로 떠도 엔컴에서 조회할 수 없어 확인할 방법이 없으므로 판정에서
            뺐습니다. <b className="text-foreground">명부에서 지운 것은 아닙니다</b> — 고치면 바로
            다시 들어옵니다.
          </p>
        </div>
        {blocking.length === 0 ? (
          <p className="rounded-md border border-dashed bg-emerald-50/50 py-5 text-center text-xs text-emerald-800">
            정보가 올바르지 않은 기록이 없습니다.
          </p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {blocking.map((i) => (
                <Row key={`${i.residentId}-${i.kind}`} i={i} />
              ))}
            </ul>
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900">
              <b className="font-semibold">고치는 법.</b> 원본 엑셀에서 그 어르신 줄의 이용자번호
              칸을 확인하세요. 비어 있었다면 <b>명부에서 빼기</b>를 누르시면 되고, 다른 값이 밀려
              들어갔다면 진짜 회원번호를 찾아 살려야 합니다. 앞으로 들어오는 자료는 회원번호 모양을
              검사해 걸러내고 가져오기 미리보기에 경고를 띄웁니다.
            </p>
          </>
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold">확인이 필요한 기록 {warn.length}건</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            판정에는 그대로 넣되, 한 번 봐주시면 좋은 것들입니다. 대부분 과거 자료를 나중에 넣었을
            때 생기는 것이라 고칠 게 없습니다.{" "}
            <b className="text-foreground">보셨으면 「확인했습니다」로 접어두세요</b> — 같은 줄을
            매번 다시 읽지 않도록.
          </p>
        </div>
        {warn.length === 0 ? (
          <p className="rounded-md border border-dashed bg-emerald-50/50 py-5 text-center text-xs text-emerald-800">
            확인할 기록이 없습니다.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {warn.map((i) => (
              <Row key={`${i.residentId}-${i.kind}`} i={i} />
            ))}
          </ul>
        )}
      </Card>

      {/* 접어둔 것은 지운 것이 아닙니다. 언제든 펼쳐서 되돌릴 수 있어야, 잘못 눌렀을 때
          되찾을 방법이 있습니다. */}
      {done.length > 0 && (
        <Card className="p-5">
          <button
            type="button"
            onClick={() => setShowChecked((v) => !v)}
            className="text-sm font-semibold text-foreground hover:underline"
          >
            확인해서 접어둔 기록 {done.length}건 {showChecked ? "▴" : "▾"}
          </button>
          {showChecked && (
            <ul className="mt-3 space-y-1.5">
              {done.map((i) => (
                <Row key={`${i.residentId}-${i.kind}`} i={i} />
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
function ImportHistorySection() {
  const [logs, setLogs] = useState<ImportLog[]>([]);
  const [recent, setRecent] = useState<
    { id: string; name: string; created_at: string; meal_tier: string }[]
  >([]);
  const [logError, setLogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [a, b] = await Promise.all([listImportLogs(30), listRecentResidents(20)]);
      setLogs(a.logs);
      setLogError(a.error);
      setRecent(b.rows);
      setLoading(false);
    })();
  }, []);

  const fmt = (iso: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "–");

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold">자료 가져오기 내역</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            「자료 관리」에서 엔컴 엑셀을 반영할 때마다 한 줄씩 쌓입니다. 기록은 고치거나 지울 수
            없습니다.
          </p>
        </div>

        {logError && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900">
            <b className="font-semibold">기록 표가 아직 없습니다.</b> Supabase SQL Editor에서{" "}
            <code className="rounded bg-white px-1">supabase/migration_020_import_logs.sql</code> 을
            한 번 실행하면 이 다음 가져오기부터 기록이 남습니다.
            <span className="mt-1 block text-amber-800/70">({logError})</span>
          </div>
        )}

        {loading ? (
          <p className="py-4 text-center text-xs text-muted-foreground">불러오는 중…</p>
        ) : !logError && logs.length === 0 ? (
          <p className="rounded-md border border-dashed bg-stone-50 py-5 text-center text-xs text-muted-foreground">
            아직 가져오기 내역이 없습니다.
          </p>
        ) : (
          logs.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b bg-stone-50 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2.5 font-medium">반영 시각</th>
                    <th className="px-3 py-2.5 font-medium">담당자</th>
                    <th className="px-3 py-2.5 font-medium">자료 기간</th>
                    <th className="px-3 py-2.5 font-medium">읽은 기록</th>
                    {/* "정말 추가됐는가"가 이 표의 핵심입니다. 저장은 하고 있었는데
                        화면에 안 보여서, 넣고도 반영됐는지 알 수 없었습니다. */}
                    <th className="px-3 py-2.5 font-medium">새로 추가</th>
                    <th className="px-3 py-2.5 font-medium">이미 있어 건너뜀</th>
                    <th className="px-3 py-2.5 font-medium">파일</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id} className="border-b last:border-0 hover:bg-stone-50">
                      <td className="px-3 py-2.5 text-xs tabular-nums">{fmt(l.created_at)}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">
                        {l.staff_email || "–"}
                      </td>
                      <td className="px-3 py-2.5 text-xs tabular-nums">
                        {l.period_from ? `${l.period_from} ~ ${l.period_to}` : "–"}
                      </td>
                      <td className="px-3 py-2.5 text-xs tabular-nums">
                        {l.record_count.toLocaleString()}건
                        <span className="ml-1 text-muted-foreground">
                          · 어르신 {l.resident_count}명
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs tabular-nums">
                        {(l.new_attendance ?? 0) > 0 || (l.new_residents ?? 0) > 0 ? (
                          <span className="font-semibold text-emerald-700">
                            출결 {(l.new_attendance ?? 0).toLocaleString()}건
                            {(l.new_residents ?? 0) > 0 && ` · 어르신 ${l.new_residents}명`}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">없음</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs tabular-nums text-muted-foreground">
                        {(l.skipped_attendance ?? 0).toLocaleString()}건
                      </td>
                      <td
                        className="max-w-64 truncate px-3 py-2.5 text-xs text-muted-foreground"
                        title={l.file_names}
                      >
                        {l.file_names || "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold">신규 추가된 어르신</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            자료를 가져올 때 <b className="text-foreground">명부에 처음 들어온 분</b>만 모았습니다.
            들어온 날짜별로 묶여 있어, 어느 가져오기에서 누가 새로 생겼는지 바로 볼 수 있습니다.
          </p>
        </div>
        {loading ? (
          <p className="py-4 text-center text-xs text-muted-foreground">불러오는 중…</p>
        ) : recent.length === 0 ? (
          <p className="rounded-md border border-dashed bg-stone-50 py-5 text-center text-xs text-muted-foreground">
            표시할 어르신이 없습니다.
          </p>
        ) : (
          <div className="space-y-4">
            {Object.entries(
              recent.reduce<Record<string, typeof recent>>((acc, r) => {
                const day = r.created_at?.slice(0, 10) ?? "날짜 없음";
                (acc[day] ||= []).push(r);
                return acc;
              }, {}),
            )
              .sort((a, b) => b[0].localeCompare(a[0]))
              .map(([day, rows]) => (
                <div key={day}>
                  <div className="mb-1.5 flex flex-wrap items-baseline gap-2 border-b pb-1">
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {day}
                    </span>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                      신규 {rows.length}명
                    </span>
                  </div>
                  <ul className="grid gap-1.5 sm:grid-cols-2">
                    {rows.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm"
                      >
                        <span className="font-medium">{r.name}</span>
                        <span className="text-xs text-muted-foreground">{r.id}</span>
                        <span className="ml-auto text-[11px] text-muted-foreground">
                          {r.meal_tier}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </Card>
    </div>
  );
}
import { NavBar } from "@/components/NavBar";
import { Pencil, Plus, ShieldCheck, Trash2, UserCheck, UserX } from "lucide-react";
import { useSession, useStaffName } from "@/lib/use-session";
import { getFactorToggles, type FactorToggles } from "@/lib/external-factors";
import { saveFactorSettings } from "@/lib/factor-settings";
import { getWeatherStatus } from "@/lib/weather";
import { Switch } from "@/components/ui/switch";

/** 지금 화면에 띄우는 외부변수는 이 둘뿐입니다. */
type FactorKey = "badWeather" | "special";
import {
  deleteAccessRequest,
  deleteSuggestion,
  fetchAccessRequests,
  fetchSuggestions,
  setAccessRequestStatus,
  isAccessApprover,
  updateSuggestion,
  type AccessRequest,
  type AccessRequestStatus,
  type Suggestion,
} from "@/lib/requests";
import {
  DATA_END_STR,
  HOLIDAY_LABELS,
  addHoliday,
  residents,
  notifyDataChanged,
  removeHoliday,
  useDataVersion,
} from "@/lib/attendance-engine";

const ADMIN_TABS = [
  // "members" 를 뺐습니다. 탭 자체가 없어졌는데 허용 목록에만 남아 있어서,
  // /admin?tab=members 로 들어오면 validateSearch 는 통과하고 활성 탭은 없는 상태가 되어
  // **탭 바만 남고 본문이 백지**였습니다. 바로 아래 주석이 경고해 둔 그 버그가
  // 회원관리를 상단 메뉴로 옮기면서 재발했습니다.
  "pattern",
  "imports",
  "issues",
  "holidays",
  "suggestions",
  "requests",
] as const;
type AdminTab = (typeof ADMIN_TABS)[number];

export const Route = createFileRoute("/admin")({
  // 아는 탭 이름만 받습니다. 예전에는 아무 문자열이나 통과시켜서 `?tab=factors` 처럼
  // 없는 값으로 들어오면 **탭 바만 남고 화면이 백지**가 됐습니다(활성 탭이 하나도 없음).
  validateSearch: (search: Record<string, unknown>): { tab?: AdminTab } => ({
    tab: ADMIN_TABS.includes(search.tab as AdminTab) ? (search.tab as AdminTab) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "관리자 설정 | 밥상위의 신호" },
      {
        name: "description",
        content: "어르신·패턴·자료 반영 내역·자료 점검·외부변수를 관리합니다.",
      },
    ],
  }),
  component: AdminPage,
});

// 실제 어르신 데이터를 추가/수정/삭제·사진 업로드하려면 로그인이 필요합니다(Supabase Auth).
function AdminPage() {
  const version = useDataVersion();
  const session = useSession();
  // 대시보드와 **같은 함수**로 셉니다. 따로 계산하면 두 화면이 다른 날짜를 말하게 됩니다.
  const freshness = useMemo(() => getDataFreshness(20), [version]);
  const { tab } = Route.useSearch();
  // 가입 승인은 이 시스템에 누가 들어올지 정하는 일이라 담당자 계정만 할 수 있습니다.
  // 아래는 탭을 감추는 것뿐이고, 실제로 막는 것은 데이터베이스 정책입니다.
  const canApprove = isAccessApprover(session?.user.email);

  // 대기 중인 신청 건수. 탭에 숫자를 붙여두지 않으면 관리자 화면에 들어와서 탭을 한 번 더
  // 눌러봐야 새 신청이 있는지 알 수 있습니다. 가입 신청은 그 사람이 일을 시작하지 못하고
  // 기다리는 상태라, 늦게 알아채는 것 자체가 문제입니다.
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    if (!canApprove) return;
    void fetchAccessRequests().then(({ rows }) => {
      setPendingCount(rows.filter((r) => r.status === "pending").length);
    });
  }, [canApprove]);

  return (
    <div className="min-h-screen bg-stone-50">
      <NavBar />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">관리자 설정</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            어르신 명부와 패턴, 들어온 자료와 그 점검, 휴관일과 외부변수를 관리합니다.
          </p>
        </div>

        {/* 자료가 며칠째 안 들어왔는지 — 관리자 화면 맨 위에 둡니다.
            자료 반영은 승인된 직원 누구나 할 수 있게 열어 두었습니다. 편한 대신, 아무도
            자기 일이라고 생각하지 않으면 며칠씩 빕니다. 실제로 9월 1~9일이 그렇게 비었고
            그동안 9월은 통째로 판단에서 빠져 있었습니다. 대시보드에만 띄우면 "누군가
            보겠지"가 되므로, 챙길 사람이 보는 자리에도 같이 올립니다. */}
        {freshness.status !== "ok" && (
          <div
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              freshness.status === "stale"
                ? "border-red-300 bg-red-50 text-red-900"
                : "border-amber-300 bg-amber-50 text-amber-900"
            }`}
          >
            <b className="font-semibold">
              {freshness.status === "stale" ? "자료가 밀렸습니다" : "자료 확인이 필요합니다"}
            </b>{" "}
            · 평일 {freshness.missingWeekdays}일째 새 자료가 들어오지 않았습니다 (마지막 자료{" "}
            <span className="tabular-nums">{freshness.lastDataDate ?? "–"}</span>
            {freshness.gapDays > 0 && ` · ${freshness.gapDays}일 전`}).
            <p className="mt-1 text-xs leading-relaxed opacity-90">
              자료가 없는 날은 판단에서 빠집니다 — 그동안은 긴급 인원이 실제보다 적게 보입니다.
              <Link to="/resources" className="ml-1 font-semibold underline">
                자료 관리에서 반영하기 ›
              </Link>
            </p>
          </div>
        )}

        {/* 「판정 기준」으로 가던 상자를 뺐습니다. 판정 기준은 읽는 자리이고 관리자
            설정은 고치는 자리라, 같은 화면에 두니 설정 항목처럼 보였습니다.
            길은 통계·분석 화면 맨 위에 남아 있습니다(/criteria). */}

        <Tabs defaultValue={tab ?? "pattern"}>
          <TabsList className="w-full justify-start overflow-x-auto sm:w-auto sm:justify-center sm:overflow-visible">
            <TabsTrigger value="pattern">패턴 분석</TabsTrigger>
            <TabsTrigger value="imports">자료 반영 내역</TabsTrigger>
            <TabsTrigger value="issues">자료 점검</TabsTrigger>
            <TabsTrigger value="holidays">외부변수</TabsTrigger>
            <TabsTrigger value="suggestions">건의·문의</TabsTrigger>
            {/*
              가입 신청은 맨 오른쪽에 따로 둡니다. 나머지 탭은 어르신 자료를 다루는 일상 업무라
              모든 직원이 쓰지만, 이것만은 "누가 이 시스템에 들어올 수 있는가"를 정하는 일이고
              담당자 한 사람만 볼 수 있습니다(데이터베이스 정책 is_access_approver). 성격이 다른
              일이니 줄 끝으로 떼어놓고, 색으로도 구분되게 했습니다.
            */}
            {canApprove && (
              <TabsTrigger
                value="requests"
                className="ml-auto gap-1.5 border border-amber-300 bg-amber-50 font-semibold text-amber-900 data-[state=active]:border-amber-400 data-[state=active]:bg-amber-100 data-[state=active]:text-amber-950"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                가입 신청
                {pendingCount > 0 && (
                  <span
                    className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-600 px-1.5 text-[11px] font-bold text-white"
                    aria-label={`대기 중 ${pendingCount}건`}
                  >
                    {pendingCount}
                  </span>
                )}
              </TabsTrigger>
            )}
          </TabsList>

          {/* 상단 메뉴에 흩어져 있던 "어르신 관리(찾기)"와 "개인별 패턴 분석"을 관리자 설정
              안으로 들여왔습니다. 매일 쓰는 화면(대시보드)과 가끔 쓰는 관리 화면을 분리합니다.
              등록·수정 표(ResidentAdminSection)는 자료가 엔컴 가져오기로 들어오면서 쓸 일이
              없어져 탭에서 뺐습니다. */}
          <TabsContent value="pattern" className="mt-4">
            <PatternAnalysisPanel />
          </TabsContent>
          <TabsContent value="imports" className="mt-4">
            <ImportHistorySection />
          </TabsContent>
          <TabsContent value="issues" className="mt-4">
            <DataIssueSection />
          </TabsContent>
          <TabsContent value="holidays" className="mt-4">
            <HolidayAdminSection />
          </TabsContent>
          <TabsContent value="suggestions" className="mt-4">
            <SuggestionsPanel />
          </TabsContent>
          {canApprove && (
            <TabsContent value="requests" className="mt-4">
              <AccessRequestsPanel onPendingChange={setPendingCount} />
            </TabsContent>
          )}
        </Tabs>
      </main>
    </div>
  );
}

// ── 어르신 등록/수정/퇴소 ────────────────────────────────────────

// 「회원관리」 탭을 상단 메뉴로 옮기면서 이 화면(ResidentAdminSection, 246줄)을 지웠습니다.
// 어르신 등록·수정 표인데, 자료가 엔컴 가져오기로 들어오면서 쓸 일이 없어져 탭에서
// 빠진 뒤로는 아무도 부르지 않았습니다. 필요해지면 git 이력에서 꺼내면 됩니다.

// ── 외부변수 관리 ────────────────────────────────────────────
// 공휴일뿐 아니라 폭설·폭염 등 기상 특보, 감염병 유행, 임시 휴관처럼 어르신 개인의 잘못이 아닌
// "기관 전체에 영향을 준 외부 요인"을 날짜 단위로 등록하는 곳입니다. 여기 등록하면 개인별 위험도
// 계산(출석 패턴 분석)과 대시보드의 "AI 패턴 분석에 반영된 외부변수" 목록에 바로 반영됩니다.

/**
 * 지금 쓰는 외부변수는 **둘뿐입니다.**
 *
 * 한때 다섯이었습니다(장날·명절 전후·기초연금까지). 우리 자료로 재보니 셋은 출석률 차이가
 * 흩어짐과 구분되지 않았고, 근거 없는 변수를 켜둔 채로 두면 "장날이라 안 오셨겠지"로
 * **진짜 신호를 넘깁니다.** 그래서 화면에서 뺐습니다.
 *
 * 남긴 둘은 성격이 정반대입니다 —
 *
 *   날씨       덜 오실 만한 사정. 자동으로 받아오고, 근거 문구에만 붙습니다.
 *   특식·행사   **더** 오실 만한 사정. 담당자가 직접 넣고, 그날 결석을 더 들여다봅니다.
 *
 * 둘 다 스위치로 끌 수 있고, 끄면 그 즉시 판단 근거에서 빠집니다. 우리 기관에서 날씨가
 * 무효라고 해서 다른 기관에서도 무효인 것은 아니라, 끄고 켜는 것은 기관의 결정입니다.
 */
const FACTOR_UI: Record<
  "badWeather" | "special",
  { title: string; source: string; effect: string; why: string }
> = {
  badWeather: {
    title: "날씨",
    source: "자동 연동 (Open-Meteo 기상 자료)",
    effect: "켜면 그날의 판단 근거에 「비 12mm」처럼 날씨가 함께 붙습니다.",
    why: "우리 자료에서는 −1.2%p로 무효에 가깝습니다. 그래서 점수는 바꾸지 않고 설명에만 씁니다 — 날을 통째로 빼면 하필 그날부터 안 나오신 분이 가려집니다.",
  },
  special: {
    title: "특식·행사",
    source: "담당자가 직접 등록 (+ 식단표에 적힌 행사)",
    effect: "켜면 그날 안 나오신 분을 더 들여다봅니다. 근거 문구에 「행사일인데 결석」이 붙습니다.",
    why: "다른 변수와 방향이 반대입니다. 평소보다 많이 오시는 날이라, 그런 날의 결석이 가장 강한 신호입니다.",
  },
};

function HolidayAdminSection() {
  // 검증 기록에 쓸 실측값. 화면을 열 때 지금 자료로 다시 잽니다 — 어딘가에 적어둔 숫자가
  // 아니라 **오늘 이 기관의 자료로 방금 계산한 값**이어야 근거가 됩니다.
  const version = useDataVersion();
  const factorImpact = useMemo(() => getFactorImpact(), [version]);

  const [date, setDate] = useState("");

  // ── 외부변수 스위치 ──────────────────────────────────────
  // 값은 데이터베이스(app_settings)에 저장합니다. 브라우저에 두면 담당자가 "날씨는 근거가
  // 없으니 끄자"고 정해도 다른 직원 화면에는 그대로 남아, 같은 어르신을 두고 두 사람이
  // 다른 근거를 보게 됩니다.
  const staffName = useStaffName();
  const [toggles, setToggles] = useState<FactorToggles>(() => getFactorToggles());
  const [savingToggle, setSavingToggle] = useState<FactorKey | null>(null);
  const weatherStatus = useMemo(() => getWeatherStatus(), [version]);

  const flipFactor = async (kind: FactorKey, next: boolean) => {
    const before = toggles;
    // 화면에 없는 변수는 여기서 확실히 끕니다.
    //
    // 실제로 사고가 났습니다. 이 함수가 토글 **전체를 통째로** 다시 저장하는데, 화면에서
    // 뺀 장날·기초연금이 데이터베이스에는 켜진 채 남아 있었습니다. 날씨 스위치를 한 번
    // 만졌더니 그 값이 그대로 다시 저장됐고, AI 가 "장날 3일이 있었습니다"를 판단 근거로
    // 써버렸습니다. 담당자는 화면 어디에서도 본 적 없는 변수입니다.
    //
    // 화면에 스위치가 없다는 것은 "이 기관은 이 변수를 안 쓴다"는 뜻입니다. 저장할 때마다
    // 그 뜻을 데이터베이스에도 그대로 새깁니다 — 한 번만 만져도 저절로 바로잡힙니다.
    const updated: FactorToggles = {
      ...toggles,
      [kind]: next,
      market: false,
      pension: false,
      holidayAdjacent: false,
    };
    setToggles(updated);
    setSavingToggle(kind);
    const { error } = await saveFactorSettings(updated, staffName);
    setSavingToggle(null);
    if (error) {
      setToggles(before); // 저장이 안 됐는데 바뀐 것처럼 보이면 안 됩니다
      toast.error(`저장하지 못했습니다 — ${error}`);
      return;
    }
    // 판단 근거가 바뀌었으니 화면 전체를 다시 계산시킵니다.
    notifyDataChanged();
    toast.success(
      `${FACTOR_UI[kind].title}를 ${next ? "켰" : "껐"}습니다. 판단 근거에 바로 반영됩니다.`,
    );
  };

  // 행사일 직접 등록
  const [eventDate, setEventDate] = useState("");
  const [eventLabel, setEventLabel] = useState("");
  const [savingEvent, setSavingEvent] = useState(false);
  const events = useMemo(() => listMenuEvents(), [version, savingEvent]);

  const addEvent = async () => {
    if (!eventDate || !eventLabel.trim()) {
      toast.error("날짜와 행사 이름을 모두 적어주세요.");
      return;
    }
    setSavingEvent(true);
    const res = await setMenuEvent(eventDate, eventLabel.trim());
    setSavingEvent(false);
    if (!res.ok) return void toast.error(`저장하지 못했습니다 — ${res.error}`);
    toast.success(`${eventDate} · ${eventLabel.trim()} 를 행사일로 등록했습니다.`);
    setEventLabel("");
  };

  const removeEvent = async (d: string) => {
    if (!window.confirm(`${d} 를 행사일에서 빼시겠어요?`)) return;
    setSavingEvent(true);
    const res = await setMenuEvent(d, "");
    setSavingEvent(false);
    if (!res.ok) return void toast.error(`해제하지 못했습니다 — ${res.error}`);
    toast.success("행사일에서 뺐습니다.");
  };
  const [label, setLabel] = useState("");

  const holidays = Array.from(HOLIDAY_LABELS.entries())
    .map(([d, l]) => ({ date: d, label: l }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 기본은 올해. 지난해 공휴일까지 한꺼번에 펼쳐놓을 이유가 없습니다.
  const holidayYears = [...new Set(holidays.map((h) => Number(h.date.slice(0, 4))))].sort();
  const thisYear = Number(DATA_END_STR.slice(0, 4));
  const [holidayYear, setHolidayYear] = useState<number>(
    holidayYears.includes(thisYear)
      ? thisYear
      : (holidayYears[holidayYears.length - 1] ?? thisYear),
  );
  const shownHolidays = holidays.filter((h) => h.date.startsWith(String(holidayYear)));

  const handleAdd = () => {
    if (!date || !label.trim()) {
      toast.error("날짜와 사유를 모두 입력해주세요.");
      return;
    }
    addHoliday(date, label.trim());
    setDate("");
    setLabel("");
    toast.success("외부변수를 추가했습니다.");
  };

  const handleRemove = (d: string) => {
    removeHoliday(d);
    toast.success("외부변수를 삭제했습니다.");
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* ── 외부변수 두 가지 ────────────────────────────────────
          스위치를 끄면 그 즉시 판단 근거에서 빠집니다. 화면에 "켜짐"이라고 적어놓고 실제로는
          아무 일도 안 일어나는 상태가 가장 나쁩니다 — 담당자가 자기 결정이 반영됐다고 믿게
          되니까요. 그래서 각 스위치 밑에 **켜면 무엇이 달라지는지**를 그대로 적었습니다. */}
      <Card className="p-5 lg:col-span-2">
        <h2 className="mb-1 text-sm font-semibold">① 외부변수 — 켜고 끄기</h2>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          결석을 설명할 때 흔히 대는 이유들을 우리 자료로 재보고,{" "}
          <b className="text-foreground">둘만 남겼습니다.</b> 하나는 자동으로 받아오고, 하나는
          담당자가 직접 넣습니다. 끄면 그 즉시 판단 근거에서 빠집니다.
        </p>

        <div className="grid gap-3 xl:grid-cols-2 xl:items-start">
          {(["badWeather", "special"] as FactorKey[]).map((kind) => {
            const ui = FACTOR_UI[kind];
            const on = toggles[kind];
            return (
              <div
                key={kind}
                className={`rounded-lg border p-4 transition-colors ${
                  on ? "border-primary/30 bg-primary/[0.03]" : "border-stone-200 bg-stone-50/60"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{ui.title}</span>
                      <span className="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] text-muted-foreground">
                        {ui.source}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-foreground">{ui.effect}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{ui.why}</p>
                  </div>
                  <Switch
                    checked={on}
                    disabled={savingToggle === kind}
                    onCheckedChange={(v) => void flipFactor(kind, v)}
                    aria-label={`${ui.title} 켜고 끄기`}
                  />
                </div>

                {/* 날씨는 자동 연동이라, 정말 받아오고 있는지 눈으로 보여줍니다. 연동이 끊겨도
                    화면은 조용히 잘 돌아가기 때문에(날씨는 부가 정보라 실패해도 멈추지 않습니다)
                    상태를 적어두지 않으면 몇 달째 안 받아오고 있어도 아무도 모릅니다. */}
                {kind === "badWeather" && (
                  <div className="mt-3 border-t pt-3 text-xs">
                    {weatherStatus.days > 0 ? (
                      <p className="text-muted-foreground">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />
                        연동됨 ·{" "}
                        <b className="tabular-nums text-foreground">
                          {weatherStatus.days.toLocaleString()}일
                        </b>{" "}
                        보관 중 ({weatherStatus.from} ~ {weatherStatus.to}) · 새로 생긴 날짜만
                        받아옵니다
                      </p>
                    ) : (
                      <p className="text-amber-800">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-amber-500 align-middle" />
                        아직 받아온 날씨가 없습니다. 보관용 표가 없으면 그럴 수 있습니다 —{" "}
                        <b>supabase/migration_023_weather_cache.sql</b> 을 실행해주세요.
                      </p>
                    )}
                  </div>
                )}

                {/* 특식·행사는 담당자가 직접 넣는 변수라 스위치 바로 밑에 입력칸을 둡니다.
                    식단표(엔컴)에는 경로잔치·후원 물품 배부 같은 행사가 안 적힙니다. */}
                {kind === "special" && (
                  <div className="mt-3 border-t pt-3">
                    <div className="flex flex-wrap gap-2">
                      <Input
                        type="date"
                        value={eventDate}
                        onChange={(e) => setEventDate(e.target.value)}
                        className="w-40"
                        disabled={!on}
                      />
                      <Input
                        value={eventLabel}
                        onChange={(e) => setEventLabel(e.target.value)}
                        placeholder="예: 경로잔치, 후원 물품 배부, 생신상"
                        onKeyDown={(e) => e.key === "Enter" && void addEvent()}
                        className="min-w-[180px] flex-1"
                        disabled={!on}
                      />
                      <Button onClick={() => void addEvent()} disabled={savingEvent || !on}>
                        <Plus className="mr-1.5 h-4 w-4" />
                        등록
                      </Button>
                    </div>

                    {events.length > 0 ? (
                      <ul className="mt-3 max-h-56 divide-y overflow-y-auto rounded-md border">
                        {events.slice(0, 30).map((ev) => (
                          <li
                            key={ev.date}
                            className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                          >
                            <span className="min-w-0 truncate">
                              <span className="font-medium tabular-nums text-foreground">
                                {ev.date}
                              </span>{" "}
                              <span className="text-muted-foreground">{ev.label}</span>
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0"
                              onClick={() => void removeEvent(ev.date)}
                              disabled={savingEvent}
                              aria-label={`${ev.date} 행사일 해제`}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-3 text-xs text-muted-foreground">
                        등록된 행사일이 없습니다.
                      </p>
                    )}
                    {events.length > 30 && (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        최근 30건만 보여드립니다 (전체 {events.length}건).
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── 검증 기록 ────────────────────────────────────────────
          왜 둘만 남았는지를 숫자로 답하는 자리입니다. 어딘가에 적어둔 값이 아니라 화면을 열 때
          지금 이 기관의 자료로 방금 계산한 값입니다. */}
      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold">② 우리 자료로 재본 결과</h2>
        <p className="mb-1 text-xs leading-relaxed text-muted-foreground">
          &ldquo;비 와서 그렇겠지&rdquo;, &ldquo;장날이라 안 오셨겠지&rdquo; — 현장에서 결석을
          설명할 때 흔히 대는 이유들입니다. 이 통념 때문에 진짜 신호를 넘깁니다. 그래서{" "}
          <b className="text-foreground">직접 재봤습니다.</b>
        </p>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          그 변수에 해당하는 날의 평균 출석률과, 해당하지 않는 날의 평균 출석률을 비교한 값입니다.{" "}
          <b className="text-foreground">화면을 열 때마다 다시 계산합니다.</b>
        </p>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b bg-stone-50 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2.5 font-medium">변수</th>
                <th className="px-3 py-2.5 font-medium">해당 일수</th>
                <th className="px-3 py-2.5 font-medium">그날 출석률</th>
                <th className="px-3 py-2.5 font-medium">나머지 날</th>
                <th className="px-3 py-2.5 font-medium">차이</th>
                <th className="px-3 py-2.5 font-medium">지금 상태</th>
              </tr>
            </thead>
            <tbody>
              {factorImpact
                .filter((f) => f.kind === "badWeather" || f.kind === "special")
                .map((f) => {
                  const enough = f.daysWith > 0 && f.daysWithout > 0;
                  // 3%p 를 경계로 씁니다 — 4년치 검정에서 이 아래는 흩어짐과 구분되지 않았습니다.
                  const meaningful = enough && Math.abs(f.diff) >= 3;
                  const on = toggles[f.kind as FactorKey];
                  return (
                    <tr key={f.kind} className="border-b last:border-0">
                      <td className="px-3 py-2.5">{f.name}</td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {enough ? `${f.daysWith}일` : "–"}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {enough ? `${f.rateWith}%` : "–"}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {enough ? `${f.rateWithout}%` : "–"}
                      </td>
                      <td
                        className={`px-3 py-2.5 font-semibold tabular-nums ${
                          meaningful ? "text-amber-800" : "text-muted-foreground"
                        }`}
                      >
                        {enough ? `${f.diff > 0 ? "+" : ""}${f.diff}%p` : "–"}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={
                            on
                              ? "rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800"
                              : "rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] text-stone-600"
                          }
                        >
                          {on ? "켜짐 · 근거에 반영" : "꺼짐 · 쓰지 않음"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5 text-xs leading-relaxed">
          <b className="font-semibold text-foreground">이 표가 말하는 것</b>
          <p className="mt-1 text-muted-foreground">
            날씨는 <b className="text-foreground">우리 기관에서는 거의 무효</b>였습니다. 그래서
            점수는 바꾸지 않고 설명에만 씁니다. 그래도 지우지 않은 이유는{" "}
            <b className="text-foreground">
              우리 자료에서 무효라고 다른 기관에서도 무효인 것은 아니기
            </b>{" "}
            때문입니다 — 산간이나 시장 옆 기관은 이 표를 자기 자료로 다시 채우고, 유효하면 켜면
            됩니다.
          </p>
          <p className="mt-1.5 text-muted-foreground">
            특식·행사만 방향이 반대입니다. 날씨가 &ldquo;덜 오실 만한 사정&rdquo;이라면 이것은{" "}
            <b className="text-foreground">&ldquo;더 오실 만한 사정&rdquo;</b>이라, 계산에서 빼지
            않고 <b className="text-foreground">그날의 결석을 더 들여다보는 데</b> 씁니다.
          </p>
          <p className="mt-1.5 text-muted-foreground">
            장날·명절 전후·기초연금은 재본 결과 차이가 흩어짐과 구분되지 않아{" "}
            <b className="text-foreground">화면에서 뺐습니다.</b> 근거 없는 변수를 켜둔 채로 두면
            &ldquo;장날이라 그렇겠지&rdquo;로 진짜 신호를 넘깁니다.
          </p>
        </div>
      </Card>
      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold">③ 기관이 쉰 날</h2>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          공휴일뿐 아니라 폭설·폭염 특보, 감염병 유행, 임시 휴관처럼 어르신 개인 사정이 아닌 기관
          전체 결석에 영향을 준 날짜를 등록해주세요. 등록한 날은 <b>무조건</b> 개인별 위험도
          계산에서 빠집니다 — 그날 안 나오신 것을 그 어르신 책임으로 보지 않습니다.
        </p>
        <div className="mb-4 flex gap-2">
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-40"
          />
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="예: 신정, 폭설로 임시 휴관, 독감 유행"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button onClick={handleAdd}>
            <Plus className="mr-1.5 h-4 w-4" />
            추가
          </Button>
        </div>
        {/*
          공휴일까지 다 들어 있어 마흔 날이 넘습니다. 전부 늘어놓으면 이 카드 하나가 화면
          2,500px 을 먹어, 정작 매일 보는 스위치가 저 아래로 밀립니다. 그래서 연도로 나누고
          한 화면 높이 안에서 스크롤하게 합니다 — 지우려고 찾을 때만 쓰는 목록입니다.
        */}
        {holidayYears.length > 1 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {holidayYears.map((y) => (
              <button
                key={y}
                type="button"
                onClick={() => setHolidayYear(y)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  y === holidayYear
                    ? "border-stone-800 bg-stone-800 text-white"
                    : "border-stone-200 bg-white text-muted-foreground hover:border-stone-400"
                }`}
              >
                {y}년
                <span className="ml-1 tabular-nums opacity-70">
                  {holidays.filter((h) => h.date.startsWith(String(y))).length}
                </span>
              </button>
            ))}
          </div>
        )}
        <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
          {shownHolidays.map((h) => (
            <li key={h.date} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium tabular-nums text-foreground">{h.date}</span>{" "}
                <span className="text-muted-foreground">{h.label}</span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => handleRemove(h.date)}
                aria-label={`${h.date} 지우기`}
              >
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            </li>
          ))}
          {shownHolidays.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              이 해에 등록된 날이 없습니다.
            </p>
          )}
        </ul>
        <p className="mt-2 text-[11px] text-muted-foreground">
          모두 {holidays.length}일 등록돼 있습니다.
        </p>
      </Card>
    </div>
  );
}

const REQUEST_STATUS_LABELS: Record<AccessRequestStatus, string> = {
  pending: "대기 중",
  approved: "승인",
  rejected: "반려",
};

const REQUEST_STATUS_STYLES: Record<AccessRequestStatus, string> = {
  pending: "border-amber-200 bg-amber-50 text-amber-800",
  approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rejected: "border-stone-200 bg-stone-50 text-stone-600",
};

// 가입 신청 확인란.
//
// 이제 승인 버튼이 실제로 접근 권한을 줍니다. 신청자가 신청할 때 이미 자기 비밀번호로 계정을
// 만들어 두었기 때문에(비밀번호를 신청 표에 평문으로 담지 않으려면 그 방법뿐입니다), 승인은
// 계정을 만들어주는 일이 아니라 이미 있는 계정의 문을 열어주는 일입니다. 데이터베이스 정책이
// status='approved' 인 계정만 표를 읽게 하므로(migration_010), 이 버튼 한 번으로 끝납니다.
//
// 브라우저에서 계정을 직접 만들지 않는 이유는 그대로입니다 — 계정 생성은 service_role 권한이
// 필요하고, 그 키가 프런트엔드에 들어가면 RLS를 통째로 우회할 수 있게 됩니다.
//
// 반려·삭제도 실제로 효력이 있습니다. 어느 쪽이든 그 계정은 다음 새로고침부터 아무것도 볼 수
// 없게 됩니다(계정 자체는 남습니다 — 완전히 없애려면 Supabase → Authentication → Users).
function AccessRequestsPanel({ onPendingChange }: { onPendingChange: (n: number) => void }) {
  const [rows, setRows] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { rows: fetched, error: err } = await fetchAccessRequests();
    setRows(fetched);
    setError(err);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const changeStatus = async (id: string, status: AccessRequestStatus) => {
    const { error: err } = await setAccessRequestStatus(id, status);
    if (err) {
      toast.error("상태를 바꾸지 못했습니다.");
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
    toast.success(`${REQUEST_STATUS_LABELS[status]}(으)로 표시했습니다.`);
  };

  const remove = async (id: string) => {
    const { error: err } = await deleteAccessRequest(id);
    if (err) {
      toast.error("삭제하지 못했습니다.");
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const pending = rows.filter((r) => r.status === "pending");

  // 승인·반려·삭제하면 탭에 붙은 숫자도 같이 줄어야 합니다. 처리했는데 숫자가 그대로면
  // 아직 남은 줄 알고 다시 들어와 보게 됩니다.
  useEffect(() => {
    onPendingChange(pending.length);
  }, [pending.length, onPendingChange]);

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">가입 신청</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            대기 중 {pending.length}건 · 전체 {rows.length}건
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          새로 고침
        </Button>
      </div>

      <p className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-900">
        <b className="font-semibold">승인을 누르면 그 즉시 사용할 수 있게 됩니다.</b> 신청자는
        신청할 때 이미 본인 비밀번호를 정해두었으므로, 따로 계정을 만들거나 비밀번호를 알려줄 필요가
        없습니다. 반려하면 반대로 그 계정은 아무것도 볼 수 없게 됩니다.
      </p>

      {/*
        이 시스템에서 "이 계정이 정말 그 사람 것인가"를 확인하는 유일한 지점입니다.
        메일 확인 절차를 쓰지 않기 때문입니다(무료 요금제는 메일 발송이 시간당 2건이라
        켜면 가입을 두 명밖에 못 받습니다). 승인 전까지는 어떤 자료도 열리지 않으므로
        자물쇠는 여기 하나에 걸려 있고, 그래서 이름만 보고 누르면 안 됩니다.
      */}
      <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
        <b className="font-semibold">누르기 전에 본인에게 직접 확인해주세요.</b> 이 화면이 &ldquo;이
        계정이 정말 그 사람 것인가&rdquo;를 확인하는 유일한 자리입니다. 신청서에 적힌 이름은 누구나
        적을 수 있습니다 — 아직 가입하지 않은 동료의 기관 주소로도 신청할 수 있습니다. 전화나
        대면으로 &ldquo;방금 신청하셨나요&rdquo; 한마디만 확인하고 눌러주세요. 승인하는 순간 어르신{" "}
        {/* 명부 인원을 숫자로 박아두면 안 됩니다 — 실제 400명인데 2,828명이라고 적혀 있었습니다.
            승인의 무게를 전하는 문구가 일곱 배 틀린 수치면 그 문구를 아무도 안 믿습니다. */}
        <b className="font-semibold">{residents.length.toLocaleString()}명</b>의 기록이 열립니다.
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground">불러오는 중입니다...</p>
      ) : error ? (
        <p className="text-sm text-red-600">
          신청 목록을 읽지 못했습니다. supabase/ 폴더의 migration_008 · migration_010 을 실행했는지
          확인해주세요. ({error})
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">아직 가입 신청이 없습니다.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{r.name || "이름 미기재"}</span>
                  <span className="text-xs text-muted-foreground">{r.email}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${REQUEST_STATUS_STYLES[r.status]}`}
                  >
                    {REQUEST_STATUS_LABELS[r.status]}
                  </span>
                </div>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {r.createdAt.slice(0, 10)}
                </span>
              </div>
              {r.note && <p className="mt-1.5 text-xs text-muted-foreground">{r.note}</p>}
              <div className="mt-2.5 flex flex-wrap gap-2">
                {r.status !== "approved" && (
                  <Button size="sm" onClick={() => void changeStatus(r.id, "approved")}>
                    <UserCheck className="mr-1 h-3.5 w-3.5" />
                    승인
                  </Button>
                )}
                {r.status !== "rejected" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void changeStatus(r.id, "rejected")}
                  >
                    <UserX className="mr-1 h-3.5 w-3.5" />
                    반려
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void remove(r.id)}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  삭제
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const SUGGESTION_CATEGORY_STYLES: Record<string, string> = {
  건의: "border-blue-200 bg-blue-50 text-blue-700",
  질문: "border-purple-200 bg-purple-50 text-purple-700",
  "오류 신고": "border-red-200 bg-red-50 text-red-700",
};

// 건의·문의 확인란. 답변을 적어두면 나중에 같은 질문이 올라올 때 무엇이라 답했는지 찾을 수
// 있습니다(작성자에게 자동으로 전달되지는 않습니다 — 연락은 직접 하셔야 합니다).
function SuggestionsPanel() {
  const [rows, setRows] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    const { rows: fetched, error: err } = await fetchSuggestions();
    setRows(fetched);
    setError(err);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const saveReply = async (id: string) => {
    const reply = (drafts[id] ?? "").trim();
    const { error: err } = await updateSuggestion(id, { reply });
    if (err) {
      toast.error("답변을 저장하지 못했습니다.");
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, reply } : r)));
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    toast.success("답변을 저장했습니다.");
  };

  const toggleDone = async (r: Suggestion) => {
    const status = r.status === "done" ? "open" : "done";
    const { error: err } = await updateSuggestion(r.id, { status });
    if (err) {
      toast.error("상태를 바꾸지 못했습니다.");
      return;
    }
    setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, status } : x)));
  };

  const remove = async (id: string) => {
    const { error: err } = await deleteSuggestion(id);
    if (err) {
      toast.error("삭제하지 못했습니다.");
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const open = rows.filter((r) => r.status === "open");

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">건의·문의</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            미처리 {open.length}건 · 전체 {rows.length}건
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          새로 고침
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">불러오는 중입니다...</p>
      ) : error ? (
        <p className="text-sm text-red-600">
          건의 목록을 읽지 못했습니다. supabase/migration_008_requests_suggestions.sql 을 실행했는지
          확인해주세요. ({error})
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">아직 등록된 건의·문의가 없습니다.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const done = r.status === "done";
            const draft = drafts[r.id];
            return (
              <li
                key={r.id}
                className={`rounded-md border p-3 ${done ? "bg-stone-50/70" : "bg-white"}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={`rounded-full border px-2 py-0.5 font-medium ${
                        SUGGESTION_CATEGORY_STYLES[r.category] ??
                        "border-stone-200 bg-stone-50 text-stone-700"
                      }`}
                    >
                      {r.category}
                    </span>
                    <span className="text-muted-foreground">{r.author || "익명"}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {r.createdAt.slice(0, 10)}
                    </span>
                    {done && (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        처리 완료
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => void toggleDone(r)}
                    >
                      {done ? "미처리로" : "처리 완료"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => void remove(r.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>

                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {r.text}
                </p>

                {r.reply && draft === undefined && (
                  <div className="mt-2.5 rounded-md border-l-2 border-l-primary bg-stone-50 px-3 py-2">
                    <div className="text-[11px] font-medium text-muted-foreground">답변</div>
                    <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed">{r.reply}</p>
                  </div>
                )}

                {draft === undefined ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2.5 h-7 text-xs"
                    onClick={() => setDrafts((prev) => ({ ...prev, [r.id]: r.reply }))}
                  >
                    <Pencil className="mr-1 h-3 w-3" />
                    {r.reply ? "답변 수정" : "답변 적기"}
                  </Button>
                ) : (
                  <div className="mt-2.5">
                    <Textarea
                      value={draft}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                      placeholder="확인한 내용이나 처리 결과를 적어주세요."
                      className="min-h-16"
                    />
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" onClick={() => void saveReply(r.id)}>
                        저장
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setDrafts((prev) => {
                            const next = { ...prev };
                            delete next[r.id];
                            return next;
                          })
                        }
                      >
                        취소
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
