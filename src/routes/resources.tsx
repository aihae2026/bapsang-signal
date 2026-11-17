import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  ClipboardList,
  Database,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
  Wrench,
} from "lucide-react";
import { reloadData } from "@/lib/attendance-engine";
import { importEncom, parseEncomFiles, type ParsedEncom } from "@/lib/encom-import";

// 엔컴 급식자료 추출 도구. 앱과 함께 배포됩니다(public/downloads/).
//
// 예전에는 보관함(Supabase Storage)에 올려 두고 목록을 읽어 왔습니다. 압축파일이 36MB라
// 배포 한도(25MB)를 넘겼기 때문입니다. 그런데 그 방식은 버킷이 없으면 화면에 노란 경고만
// 뜨고 아무것도 못 받습니다 — 실제로 그런 일이 있었습니다.
//
// 지금 도구는 **HTML 한 장(1MB)** 이라 앱 안에 그냥 넣을 수 있습니다. 넣어 두면 보관함도,
// 권한도, 만료되는 주소도 필요 없습니다. 누르면 그냥 받아집니다.
const ENCOM_TOOL_PATH = "/downloads/encom-meal-extractor.html";
const ENCOM_TOOL_NAME = "엔컴 급식자료 추출도구.html";

// 빈 입력 양식(엑셀 한 장). 엔컴을 쓰지 않는 기관을 위한 것입니다.
//
// 급식 출결을 손으로 적거나 다른 프로그램에서 받아 쓰는 기관은 위 추출 도구를 쓸 수 없습니다.
// 그렇다고 열 이름을 알아서 맞추시라고 하면 한 글자만 달라도 「머리글을 찾지 못했습니다」가
// 뜹니다. 그래서 읽는 쪽이 기대하는 열 이름 그대로 적힌 빈 장을 드립니다.
//
// 어르신 자료는 들어 있지 않습니다 — 머리글과 예시 한 줄(홍○동 · 2026-0000)뿐입니다.
const TEMPLATE_PATH = "/downloads/data-template.xlsx";
const TEMPLATE_NAME = "밥상위의 신호 - 데이터 양식.xlsx";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NavBar } from "@/components/NavBar";
import { useAccessStatus, useSession } from "@/lib/use-session";

// 자료 관리 — 엔컴 자료를 분석에 반영하고, 필요한 프로그램을 내려받는 곳입니다.
//   ① 자료 올리기   : 엔컴에서 내려받은 엑셀 등을 드래그하거나 찾아서 올립니다
//   ② 프로그램 내려받기: 엔컴 자동화 프로그램 등 배포 파일
// (분석 기준 설명은 통계·분석 화면 최상단으로 옮겼습니다)

export const Route = createFileRoute("/resources")({
  head: () => ({
    meta: [
      { title: "자료 관리 | 밥상위의 신호" },
      {
        name: "description",
        content: "엔컴 급식 자료를 가져와 분석에 반영하고, 자동화 프로그램을 내려받습니다.",
      },
    ],
  }),
  component: ResourcesPage,
});

function EncomImportCard({ canManage }: { canManage: boolean }) {
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedEncom | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [result, setResult] = useState<{
    newResidents: number;
    newAttendance: number;
    skippedAttendance: number;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setParsing(true);
    setParsed(null);
    setResult(null);
    setFileNames(list.map((f) => f.name));
    const result = await parseEncomFiles(list);
    setParsing(false);
    setParsed(result);
    if (result.records.length === 0) {
      // 왜 못 읽었는지는 parseEncomFiles가 이미 알고 있습니다. 예전에는 그 메시지를 계산만
      // 해놓고 버린 채 "읽을 수 있는 기록이 없습니다"만 띄웠습니다 — 파일이 잘못된 건지,
      // 열다 실패한 건지, 형식이 다른 건지 알 길이 없었습니다.
      toast.error(
        result.errors.length
          ? result.errors[0]
          : "읽을 수 있는 기록이 없습니다. 엔컴 「기간별 입금현황」 파일이 맞는지 확인해주세요.",
      );
    } else {
      toast.success(
        `${result.records.length.toLocaleString()}건을 읽었습니다. 내용을 확인하고 반영하세요.`,
      );
    }
  };

  const doImport = async () => {
    if (!parsed) return;
    if (
      !window.confirm(
        `출결 ${parsed.attendance.length.toLocaleString()}건을 분석 자료에 반영합니다.\n이미 들어와 있는 날짜는 건너뛰고 새 자료만 추가합니다.\n진행할까요?`,
      )
    )
      return;
    setImporting(true);
    const res = await importEncom(
      parsed,
      (p) => setProgress({ done: p.done, total: p.total, phase: p.phase }),
      fileNames,
    );
    setImporting(false);
    setProgress(null);
    if (!res.ok) {
      toast.error(`반영하지 못했습니다: ${res.error}`);
      return;
    }
    // "정말 추가됐는지"를 숫자로 남겨 보여줍니다. 이미 있던 날짜는 건너뛰므로, 같은 파일을
    // 다시 넣으면 '새로 추가 0건'이 나오는 것이 정상입니다.
    setResult({
      newResidents: res.newResidents,
      newAttendance: res.newAttendance,
      skippedAttendance: res.skippedAttendance,
    });
    if (res.newAttendance === 0 && res.newResidents === 0) {
      toast.info("새로 추가된 자료가 없습니다 (이미 모두 들어와 있습니다).");
      return;
    }
    toast.success(
      `새로 추가 — 출결 ${res.newAttendance.toLocaleString()}건 · 어르신 ${res.newResidents}명`,
    );
    // 넣었으면 그 자리에서 분석에 반영합니다.
    //
    // 예전에는 받아온 자료를 그대로 들고 있어서, 넣은 사람이 대시보드로 넘어가면 **넣기 전
    // 숫자**를 봤습니다. 화면만 봐서는 반영됐는지 알 수 없으니 "지금 새로고침"을 직접 누르지
    // 않으면 옛 명단으로 일하게 됩니다. 새로고침 버튼은 그대로 두되(수동으로도 되게),
    // 누르지 않아도 반영되는 것이 맞습니다.
    await reloadData();
    toast.success("분석에 반영했습니다 — 대시보드와 통계가 새 자료로 바뀌었습니다.");
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
          <FileSpreadsheet className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">① 엔컴 자료 가져오기 (분석에 반영)</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            엔컴 <b className="text-foreground">「기간별 입금현황」</b> 엑셀(.xls/.xlsx)을 끌어다
            놓거나 찾아서 올리세요. 여러 달치를 한 번에 넣어도 됩니다. 내용을 먼저 보여주고, 확인 후
            누르실 때만 반영합니다. <b className="text-foreground">엔컴에서 직접 내려받은 파일만</b>{" "}
            올려 주세요. 메일·메신저로 받은 출처를 모르는 엑셀은 올리지 마세요.
          </p>
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (canManage) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (canManage && e.dataTransfer.files) void handleFiles(e.dataTransfer.files);
        }}
        onClick={() => canManage && inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
          !canManage
            ? "cursor-not-allowed border-stone-200 bg-stone-50 opacity-60"
            : dragging
              ? "border-emerald-500 bg-emerald-50"
              : "border-stone-300 bg-white hover:border-emerald-400 hover:bg-emerald-50/40"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".xls,.xlsx,.csv"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {parsing ? (
          <Loader2 className="mb-2 h-7 w-7 animate-spin text-emerald-600" />
        ) : (
          <Upload className={`mb-2 h-7 w-7 ${dragging ? "text-emerald-600" : "text-stone-400"}`} />
        )}
        <p className="text-sm font-semibold text-foreground">
          {parsing ? "파일을 읽는 중입니다…" : "엑셀 파일을 이 영역에 끌어다 놓으세요"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">.xls · .xlsx · 여러 파일 가능</p>
        {canManage && !parsing && (
          <span className="mt-3 rounded-md border bg-white px-3 py-1.5 text-xs font-medium text-foreground">
            파일 찾아보기
          </span>
        )}
      </div>

      {/* 반영 결과 — "정말 추가됐는지"를 숫자로 확인하는 자리 */}
      {result && (
        <div className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50/70 p-4">
          <h3 className="text-sm font-semibold text-emerald-900">반영 완료</h3>
          <div className="mt-2 grid grid-cols-3 gap-3">
            <div>
              <div className="text-[11px] text-emerald-900/70">새로 추가된 출결</div>
              <div className="text-xl font-bold tabular-nums text-emerald-700">
                {result.newAttendance.toLocaleString()}건
              </div>
            </div>
            <div>
              <div className="text-[11px] text-emerald-900/70">새로 추가된 어르신</div>
              <div className="text-xl font-bold tabular-nums text-emerald-700">
                {result.newResidents}명
              </div>
            </div>
            <div>
              <div className="text-[11px] text-emerald-900/70">이미 있어 건너뜀</div>
              <div className="text-xl font-bold tabular-nums text-stone-500">
                {result.skippedAttendance.toLocaleString()}건
              </div>
            </div>
          </div>
          {result.newAttendance === 0 && result.newResidents === 0 ? (
            <p className="mt-2 text-[11px] leading-relaxed text-emerald-900/80">
              이 파일의 자료는 <b>이미 전부 들어와 있습니다.</b> 같은 파일을 다시 넣어도 자료가
              중복되거나 바뀌지 않으니 안심하셔도 됩니다.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-[11px] leading-relaxed text-emerald-900/80">
                새 자료를 위기 판정에 반영하려면 화면을 다시 불러와야 합니다.
              </p>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => window.location.reload()}
              >
                지금 새로고침
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 아무것도 못 읽었을 때 — 원인을 화면에 남깁니다.
          아래 미리보기는 읽은 게 있을 때만 나오므로, 여기가 없으면 실패 원인이 토스트와 함께
          사라져 버립니다. 파일 이름까지 같이 보여야 어느 파일이 문제인지 알 수 있습니다. */}
      {parsed && parsed.records.length === 0 && parsed.errors.length > 0 && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4">
          <h3 className="mb-2 text-xs font-semibold text-red-900">읽지 못했습니다</h3>
          <ul className="space-y-1 text-xs leading-relaxed text-red-800">
            {parsed.errors.map((e) => (
              <li key={e}>· {e}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-red-800/80">
            엔컴 「기간별 입금현황」을 엑셀로 내려받은 파일이어야 합니다. 머리글에{" "}
            <b>순번 · 처리일자 · 이용자번호</b>가 있어야 읽을 수 있습니다.
          </p>
        </div>
      )}

      {/* 미리보기 — 넣기 전에 무엇이 들어가는지 보여줍니다 */}
      {parsed && parsed.records.length > 0 && (
        <div className="mt-4 rounded-lg border bg-stone-50/70 p-4">
          <h3 className="mb-2 text-xs font-semibold text-foreground">읽은 내용 확인</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <div className="text-[11px] text-muted-foreground">기간</div>
              <div className="text-sm font-semibold tabular-nums">
                {parsed.summary.from.slice(2)} ~ {parsed.summary.to.slice(2)}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">기록</div>
              <div className="text-sm font-semibold tabular-nums">
                {parsed.summary.recordCount.toLocaleString()}건
              </div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">어르신</div>
              <div className="text-sm font-semibold tabular-nums">
                {parsed.summary.residentCount}명
              </div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">운영일</div>
              <div className="text-sm font-semibold tabular-nums">
                {parsed.summary.operatingDays}일
              </div>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            이용 구분 ·{" "}
            {parsed.summary.tiers.map((t) => `${t.label} ${t.count}명`).join(" · ") || "–"}
            {parsed.skippedRows > 0 && ` · 머리말·바닥글 ${parsed.skippedRows}행 제외`}
          </p>

          {parsed.warnings.length > 0 && (
            <ul className="mt-2.5 space-y-1">
              {parsed.warnings.map((w) => (
                <li
                  key={w.kind}
                  className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-900"
                >
                  ⚠️ {w.text}
                </li>
              ))}
            </ul>
          )}
          {parsed.errors.length > 0 && (
            <ul className="mt-2.5 space-y-1">
              {parsed.errors.map((e) => (
                <li
                  key={e}
                  className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-800"
                >
                  {e}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
            실명은 저장하지 않습니다 — <b className="text-foreground">이○영</b>처럼 가려서 넣습니다.
            나이·전화·담당자는 이 자료에 없어 &lsquo;미상/미등록/미지정&rsquo;으로 둡니다. 이미
            등록된 어르신의 정보는 덮어쓰지 않습니다.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={doImport} disabled={!canManage || importing}>
              {importing ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Database className="mr-1.5 h-4 w-4" />
              )}
              분석에 반영하기
            </Button>
            <Button variant="ghost" onClick={() => setParsed(null)} disabled={importing}>
              취소
            </Button>
            {progress && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {progress.phase === "residents" ? "어르신" : "출결"}{" "}
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function ResourcesPage() {
  const session = useSession();
  // "로그인했다"와 "볼 권한이 있다"는 다릅니다. 기관 이메일로 가입만 하고 아직 승인을 받지
  // 못한 계정도 세션은 있습니다. 예전에는 세션만 보고 가져오기·삭제 버튼을 열어줘서, 눌러 보면
  // 데이터베이스 정책 오류 메시지가 그대로 토스트에 떴습니다. 자료를 막는 것은 여전히 RLS지만
  // 화면에서도 같은 기준으로 잠가야 합니다.
  const { status: accessStatus } = useAccessStatus(session);
  const canManage = !!session && accessStatus === "approved";

  return (
    <div className="min-h-screen bg-stone-50">
      <NavBar />
      <main className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">자료 관리</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            급식 출결 자료를 가져와 분석에 반영하고, 필요한 프로그램과 입력 양식을 내려받는
            곳입니다.
          </p>
        </div>

        {!canManage && (
          <div className="mb-4 rounded-md border bg-white px-3 py-2.5 text-xs text-muted-foreground">
            파일을 올리거나 지우려면 <b className="text-foreground">로그인</b>이 필요합니다.
          </div>
        )}

        {/* ① 엔컴 자료 가져오기 — 실제로 분석에 반영됩니다 */}
        <EncomImportCard canManage={canManage} />

        {/* ② 급식데이터 추출 프로그램 — 앱과 함께 배포되는 HTML 한 장 */}
        <Card className="mt-6 p-5">
          <div className="mb-3 flex items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
              <Wrench className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">② 급식데이터 추출 프로그램</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                엔컴에서 급식 출결 자료를 받아오는 도구입니다. 안내대로 따라 하신 뒤 나온 엑셀을 위
                ①에 넣으면 분석에 반영됩니다.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-white px-3 py-2.5">
            <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-600" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={ENCOM_TOOL_NAME}>
              {ENCOM_TOOL_NAME}
            </span>
            <div className="flex shrink-0 gap-1.5">
              <Button asChild size="sm" className="h-7 px-2.5 text-xs">
                <a href={ENCOM_TOOL_PATH} target="_blank" rel="noreferrer">
                  바로 열기
                </a>
              </Button>
              <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
                <a href={ENCOM_TOOL_PATH} download={ENCOM_TOOL_NAME}>
                  <Download className="mr-1 h-3 w-3" />
                  내려받기
                </a>
              </Button>
            </div>
          </div>

          <p className="mt-2.5 rounded-md border bg-stone-50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            <b className="text-foreground">설치가 필요 없습니다.</b> 「바로 열기」를 누르면 브라우저
            안에서 그대로 쓰실 수 있습니다. 「내려받기」로 받아 두시면 인터넷이 없는 자리에서도
            파일을 두 번 눌러 여실 수 있습니다.
          </p>
        </Card>

        {/* ③ 빈 입력 양식 — 엔컴을 쓰지 않는 기관이 손으로 적어 넣는 길 */}
        <Card className="mt-6 p-5">
          <div className="mb-3 flex items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
              <ClipboardList className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">③ 데이터 양식 (엔컴을 쓰지 않으실 때)</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                급식 출결을 다른 방법으로 관리하시는 기관을 위한{" "}
                <b className="text-foreground">빈 엑셀 한 장</b>입니다. 내려받아 적으신 뒤 위 ①에
                끌어다 놓으시면 그대로 분석에 반영됩니다.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-white px-3 py-2.5">
            <FileSpreadsheet className="h-4 w-4 shrink-0 text-amber-600" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={TEMPLATE_NAME}>
              {TEMPLATE_NAME}
            </span>
            <Button asChild size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs">
              <a href={TEMPLATE_PATH} download={TEMPLATE_NAME}>
                <Download className="mr-1 h-3 w-3" />
                내려받기
              </a>
            </Button>
          </div>

          <div className="mt-2.5 rounded-md border bg-stone-50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            <p>
              <b className="text-foreground">적는 법</b> — 어르신이{" "}
              <b className="text-foreground">오신 날만</b> 한 줄씩 적습니다. 안 오신 날은 적지
              않으셔도 됩니다(비어 있으면 결석으로 읽습니다). 2행의 예시는 지우고 쓰세요.
            </p>
            <p className="mt-1.5">
              <b className="text-foreground">꼭 있어야 하는 칸</b> —{" "}
              <b className="text-foreground">처리일자</b>(오신 날)와{" "}
              <b className="text-foreground">이용자번호</b>. 이용자번호는{" "}
              <span className="font-mono">2026-0000</span>처럼 «네 자리-번호» 모양이어야 하고, 한
              분께 <b className="text-foreground">늘 같은 번호</b>를 쓰셔야 같은 분으로 이어집니다.
              열 이름은 바꾸지 마세요.
            </p>
            <p className="mt-1.5">
              이름은 올리는 자리에서 <b className="text-foreground">홍길동 → 홍○동</b>로 가려
              저장됩니다. 전화번호·주소 칸은 없습니다 — 이 도구에 어르신 연락처를 쌓지 않으려고
              일부러 두지 않았습니다.
            </p>
          </div>
        </Card>
      </main>
    </div>
  );
}
