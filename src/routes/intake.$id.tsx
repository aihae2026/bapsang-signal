/**
 * 연계 의뢰서 — 어르신 한 분을 A4 한 장으로.
 *
 * 왜 따로 만들었나: 다른 기관·부서에 어르신을 연계할 때, 지금까지는 담당자가 화면 몇 개를
 * 오가며 종이에 손으로 옮겨 적었습니다. 그 과정에서 빠지는 것이 늘 생깁니다.
 *
 * 그래서 두 가지를 한 장에 놓았습니다.
 *
 *   ① 우리가 아는 것   — 출결·판단·연락 기록. 자동으로 채웁니다.
 *   ② 우리가 모르는 것 — 생년월일·주소·보호자·수급구분. **빈칸으로 남겨둡니다.**
 *
 * 두 번째가 더 중요합니다. 우리 자료에 없는 항목을 아예 빼버리면, 받는 쪽은 그 정보가
 * 필요 없는 줄 압니다. 빈칸으로 남겨두면 담당자가 인쇄해서 손으로 채울 수 있고, 무엇이
 * 비어 있는지도 한눈에 보입니다.
 *
 * 인쇄를 전제로 만들었습니다 — 화면용 장식(내비게이션·버튼·배경)은 print 에서 전부 빠지고,
 * 입력칸은 밑줄로 바뀝니다.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NavBar } from "@/components/NavBar";
import { printPage } from "@/lib/print";
import { RiskBadge } from "@/components/RiskBadge";
import {
  DATA_END_STR,
  RESULT_KIND_META,
  describeVisitFrequency,
  formatDateWithWeekday,
  getAiRiskAssessment,
  getFollowupsForResident,
  getLastAttendanceDate,
  getResidentById,
  getResidentCalendarMonths,
  getFirstAttendanceDate,
  TODAY_DATE,
  useDataVersion,
  type ResidentDayStatus,
} from "@/lib/attendance-engine";

export const Route = createFileRoute("/intake/$id")({
  head: () => ({
    meta: [
      { title: "연계 의뢰서 | 밥상위의 신호" },
      {
        name: "description",
        content: "어르신 한 분의 기록을 A4 한 장으로 정리해 다른 기관에 연계할 때 씁니다.",
      },
    ],
  }),
  component: IntakeSheetPage,
});

/**
 * 적는 칸 — 화면에서는 타이핑, 인쇄하면 밑줄.
 *
 * 둘 다 되어야 합니다. 급할 때는 종이에 손으로 쓰는 것이 빠르고, 여러 기관에 같은 내용을
 * 보낼 때는 화면에서 치고 인쇄하는 것이 빠릅니다. 한쪽만 되게 만들면 나머지 상황에서
 * 이 서식을 안 쓰게 됩니다.
 *
 * 비워두고 인쇄하면 예전처럼 밑줄만 남습니다.
 */
function Field({
  w = "10rem",
  label,
  value,
  onChange,
}: {
  w?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="inline-block border-b border-stone-400 bg-transparent px-1 align-baseline text-[12px] leading-[1.4] text-foreground outline-none placeholder:text-stone-300 focus:border-stone-800 focus:bg-amber-50/60 print:border-black print:bg-transparent print:text-black"
      style={{ width: w }}
    />
  );
}

/**
 * 고르는 칸 — 화면에서 누르면 ☑, 인쇄하면 ☐ 로 남아 손으로 체크할 수 있습니다.
 */
function Check({
  children,
  on,
  onToggle,
}: {
  children: React.ReactNode;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className="mr-3 whitespace-nowrap rounded px-0.5 hover:bg-stone-100 print:hover:bg-transparent"
    >
      <span className="mr-1">{on ? "☑" : "☐"}</span>
      {children}
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rowline flex gap-2 border-b border-stone-200 py-1.5 last:border-0 print:border-stone-400">
      <div className="w-24 shrink-0 text-[11px] leading-6 text-muted-foreground print:text-black">
        {label}
      </div>
      <div className="min-w-0 flex-1 text-[12px] leading-6 text-foreground print:text-black">
        {children}
      </div>
    </div>
  );
}

/** 상세 화면의 달력과 같은 색을 씁니다 — 두 화면이 다른 색을 쓰면 같은 자료로 안 보입니다. */
const DAY_COLOR: Record<ResidentDayStatus, string> = {
  present: "bg-emerald-400",
  absent: "bg-red-400",
  none: "border border-stone-300 bg-stone-100",
};
const DAY_LABEL: Record<ResidentDayStatus, string> = {
  present: "오신 날",
  absent: "안 오신 날",
  none: "문 닫은 날 · 기록 없음",
};

function SectionTitle({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <h2 className="mb-1.5 mt-4 flex items-center gap-1.5 border-b-2 border-stone-800 pb-1 text-[12px] font-bold text-foreground first:mt-0 print:border-black print:text-black">
      <span className="rounded bg-stone-800 px-1.5 py-0.5 text-[10px] text-white print:bg-black">
        {n}
      </span>
      {children}
    </h2>
  );
}

function IntakeSheetPage() {
  useDataVersion();
  const { id } = Route.useParams();
  const resident = getResidentById(id);

  // 이 칸은 화면에서 적고 바로 인쇄하는 용도입니다. 저장하지 않습니다 — 연계 의견은
  // 받는 기관에 보내는 그 순간의 판단이고, 앱에 쌓아두면 어르신에 대한 또 하나의
  // 기록 더미가 됩니다(무엇을 얼마나 보관할지는 따로 정해야 하는 문제입니다).
  const [comment, setComment] = useState("");

  // 손으로 채우도록 비워둔 칸들. 화면에서 쳐도 되고, 비운 채로 인쇄해 손으로 써도 됩니다.
  // 저장하지 않습니다 — 생년월일·주소·보호자 연락처를 브라우저에 남기지 않기 위해서입니다.
  // 이 서식은 "열어서 채우고 바로 인쇄"하는 한 번짜리 종이입니다.
  const [fields, setFields] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});

  // 인쇄 창이 막혔을 때 띄우는 안내. 조용히 아무 일도 안 일어나는 것만은 없어야 합니다.
  const [printBlocked, setPrintBlocked] = useState(false);
  const handlePrint = () => printPage(() => setPrintBlocked(true));
  const fld = (key: string) => ({
    value: fields[key] ?? "",
    onChange: (v: string) => setFields((prev) => ({ ...prev, [key]: v })),
  });
  const chk = (key: string) => ({
    on: !!checks[key],
    onToggle: () => setChecks((prev) => ({ ...prev, [key]: !prev[key] })),
  });

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate(),
  ).padStart(2, "0")}`;

  const assessment = useMemo(
    () => (resident ? getAiRiskAssessment(resident, TODAY_DATE) : null),
    [resident],
  );
  const followups = useMemo(
    () => (resident ? getFollowupsForResident(resident.id) : []),
    [resident],
  );
  const lastAttendance = resident ? getLastAttendanceDate(resident) : null;

  // 상세 화면과 **같은 달력**을 씁니다. 받는 기관이 "언제부터 끊겼는지"를 눈으로 보게 하는
  // 것이 숫자 몇 개보다 빠릅니다. 최근 6개월만 — 그 앞은 앱에서 보시면 됩니다.
  const calendarMonths = useMemo(() => {
    if (!resident) return [];
    const all = getResidentCalendarMonths(resident, getFirstAttendanceDate(resident), DATA_END_STR);
    return all.slice(-6);
  }, [resident]);

  // 최근 6개월 이용 추이. 받는 기관이 "언제부터 줄었는지"를 한 줄로 보게 합니다.

  if (!resident || !assessment) {
    return (
      <div className="min-h-screen bg-stone-50">
        <NavBar />
        <main className="mx-auto max-w-3xl px-4 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            해당 어르신을 찾을 수 없습니다. 목록에서 다시 선택해주세요.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 print:bg-white">
      <div className="print:hidden">
        <NavBar />
      </div>

      {/* 인쇄 규칙 — 화면용 장식을 빼고, A4 두 장으로 또렷하게 나눕니다. */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 10mm 12mm 8mm; }
          html, body { background: #fff !important; }
          .sheet { box-shadow: none !important; margin: 0 !important; padding: 0 !important; max-width: none !important; }

          /* ── 두 장으로 또렷하게 나눕니다 ──────────────────────
             A4 한 장에 욱여넣으려고 줄 간격을 끝까지 조였던 것이 화근이었습니다. 그래도
             넘칠 때는 달력이 페이지 경계에서 잘리거나 담당자 의견 칸만 뒷장에 홀로
             남았습니다. 종이가 두 장이 되는 것보다, 어디서 넘어가는지 모르는 게 나쁩니다.

               1장  ① 기본 사항 · ② 복지관 이용 현황 · ③ 위기 판단   (대부분 손으로 채우는 장)
               2장  ④ 출석 기록 · ⑤ 연락 기록 · ⑥ 담당자 의견        (근거와 적는 칸)

             두 장으로 정한 뒤에는 **다시 조이지 않습니다.** 남는 자리는 빈칸 높이로
             돌려줘야 손으로 쓸 수 있습니다. 1장은 대부분 손으로 채우는 장이니까요. */
          .sheet .page2 { break-before: page; }
          .sheet h2 { margin-top: 10px !important; margin-bottom: 4px !important; padding-bottom: 1px !important; }
          .sheet .rowline { padding-top: 5px !important; padding-bottom: 5px !important; }
          .sheet p, .sheet td, .sheet th, .sheet li, .sheet div { line-height: 1.5 !important; }
          .sheet .fineprint { font-size: 9px !important; }
          .sheet .blankline { padding-top: 9px !important; padding-bottom: 9px !important; }
          .sheet .usebox { height: 104px !important; }
          .sheet .commentbox { height: 132px !important; }

          /* 절이 가운데서 잘리지 않게. 제목만 페이지 끝에 남는 것도 막습니다. */
          .sheet h2 { break-after: avoid; break-inside: avoid; }
          .sheet table, .sheet textarea, .sheet .keep { break-inside: avoid; }
          textarea { border-color: #000 !important; }
        }
      `}</style>

      <div className="mx-auto max-w-4xl px-4 py-6 print:p-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
          <Button asChild variant="ghost" size="sm">
            <Link to="/risk-report">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              위험군 리포트로
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/resident/$id" params={{ id: resident.id }}>
                상세 화면 보기
              </Link>
            </Button>
            <Button size="sm" onClick={handlePrint}>
              <Printer className="mr-1.5 h-4 w-4" />
              인쇄 / PDF 저장
            </Button>
          </div>
        </div>

        {/* 인쇄 창이 막혔을 때 — 버튼이 고장 난 게 아니라는 것부터 알려드립니다. */}
        {printBlocked && (
          <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-900 print:hidden">
            <b>인쇄 창이 열리지 않는 자리입니다.</b> 지금 이 화면은 다른 창 안에 끼워져 있어(앱 안의
            미리보기 패널 같은 곳), 브라우저가 인쇄 대화상자를 막습니다. 버튼이 고장 난 것은
            아닙니다.
            <div className="mt-2">
              <b>크롬·엣지 같은 브라우저에서 이 주소를 열고</b> 인쇄를 누르시면 됩니다. 새 창으로
              열면 <b>지금 적으신 내용은 옮겨지지 않으니</b>, 적기 전에 먼저 옮겨 여시는 편이
              낫습니다.
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded border border-amber-300 bg-white px-2 py-1 text-[12px] text-amber-900">
                {typeof window === "undefined" ? "" : window.location.href}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.open(window.location.href, "_blank", "noopener")}
              >
                새 창으로 열기
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPrintBlocked(false)}>
                닫기
              </Button>
            </div>
          </div>
        )}

        <div className="sheet mx-auto bg-white p-8 shadow-sm print:p-0 print:shadow-none">
          {/* ── 머리말 ───────────────────────────────────────── */}
          <div className="flex items-end justify-between border-b-2 border-stone-800 pb-2 print:border-black">
            <div>
              <h1 className="text-lg font-bold tracking-tight text-foreground print:text-black">
                어르신 연계 의뢰서
              </h1>
              <p className="mt-0.5 text-[11px] text-muted-foreground print:text-black">
                춘천남부노인복지관 · 033-241-5600 · 강원특별자치도 춘천시 방송길 86
              </p>
            </div>
            <div className="text-right text-[11px] leading-5 text-muted-foreground print:text-black">
              <div>작성일 {todayStr}</div>
              <div>
                자료 기준일 <span className="tabular-nums">{DATA_END_STR}</span>
              </div>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground print:text-black">
            <span>
              받는 기관 <Field w="9rem" label="받는 기관" {...fld("받는 기관")} /> 담당자{" "}
              <Field w="5rem" label="받는 기관 담당자" {...fld("받는 기관 담당자")} />
            </span>
            <span>
              연계 사유 <Check {...chk("사유:안부")}>안부 확인</Check>
              <Check {...chk("사유:돌봄")}>돌봄 연계</Check>
              <Check {...chk("사유:의료")}>의료</Check>
              <Check {...chk("사유:경제")}>경제</Check>
              <Check {...chk("사유:기타")}>기타</Check>
            </span>
          </div>

          {/* ── ① 기본 사항 (대부분 빈칸) ───────────────────── */}
          <SectionTitle n="①">기본 사항</SectionTitle>
          <p className="fineprint mb-1 text-[10px] leading-relaxed text-muted-foreground print:text-black">
            아래 <b>밑줄 칸은 우리 기록에 없는 항목</b>입니다.{" "}
            <b className="print:hidden">여기서 바로 쳐도 되고</b>, 비운 채로 인쇄해 손으로 쓰셔도
            됩니다. 이름은 개인정보 보호를 위해 가운데를 가려 보관하고 있어, 실명은 따로 적는 칸을
            두었습니다.
          </p>
          <div className="rounded border border-stone-300 px-3 py-1 print:border-black">
            <Row label="성명">
              <b className="text-[13px]">{resident.name}</b>
              <span className="ml-3 text-muted-foreground print:text-black">실명</span>{" "}
              <Field w="7rem" label="실명" {...fld("실명")} />
              <span className="ml-4 text-muted-foreground print:text-black">회원번호</span>{" "}
              <b className="tabular-nums">{resident.id}</b>
            </Row>
            <Row label="생년월일 / 나이">
              <Field w="8rem" label="생년월일" {...fld("생년월일")} />
              <span className="ml-3 text-muted-foreground print:text-black">만</span>{" "}
              <Field w="2.5rem" label="나이" {...fld("나이")} /> 세
              <span className="ml-4">
                <Check {...chk("성별:남")}>남</Check>
                <Check {...chk("성별:여")}>여</Check>
              </span>
              {resident.ageGroup && resident.ageGroup !== "미상" && (
                <span className="ml-2 text-muted-foreground print:text-black">
                  (기관 기록: {resident.ageGroup})
                </span>
              )}
            </Row>
            <Row label="주소">
              <Field w="100%" label="주소" {...fld("주소")} />
            </Row>
            <Row label="연락처">
              {resident.phone && resident.phone !== "미등록" ? (
                <b className="tabular-nums">{resident.phone}</b>
              ) : (
                <Field w="8rem" label="연락처" {...fld("연락처")} />
              )}
              <span className="ml-4 text-muted-foreground print:text-black">비상연락</span>{" "}
              <Field w="7rem" label="비상연락처" {...fld("비상연락처")} />
              <span className="ml-2 text-muted-foreground print:text-black">관계</span>{" "}
              <Field w="4rem" label="관계" {...fld("관계")} />
            </Row>
            <Row label="가구 형태">
              <Check {...chk("가구:독거")}>독거</Check>
              <Check {...chk("가구:부부")}>부부</Check>
              <Check {...chk("가구:자녀")}>자녀 동거</Check>
              <Check {...chk("가구:기타")}>기타</Check>
              <Field w="6rem" label="기타 가구 형태" {...fld("기타 가구 형태")} />
            </Row>
            <Row label="수급 구분">
              <Check {...chk("수급:일반")}>일반</Check>
              <Check {...chk("수급:차상위")}>차상위</Check>
              <Check {...chk("수급:기초")}>기초수급</Check>
            </Row>
            <Row label="건강 / 복약">
              <Field w="100%" label="건강 상태 및 복용 약" {...fld("건강 상태 및 복용 약")} />
            </Row>
          </div>

          {/* ── ② 복지관 이용 현황 (담당자가 적는 칸) ───────────
              급식 출결은 아래 ③·④에 있습니다. 여기는 **급식 말고 이 어르신이 복지관에서
              무엇을 하고 계신지**를 적는 자리입니다 — 평생교육 수강, 상담, 일자리 참여 같은
              것들입니다. 받는 기관이 알고 싶은 것은 "이 어르신이 어디에 닿아 있는가"이고,
              그건 출석률 숫자로는 안 보입니다. */}
          <SectionTitle n="②">복지관 이용 현황</SectionTitle>
          <p className="fineprint mb-1.5 text-[10px] leading-relaxed text-muted-foreground print:text-black">
            급식 외에 이용 중이거나 최근까지 이용하신 사업을 적어주세요. 화면에서 치셔도 되고, 비운
            채로 인쇄해 손으로 쓰셔도 됩니다.
          </p>
          <textarea
            value={fields["복지관 이용 현황"] ?? ""}
            onChange={(e) =>
              setFields((prev) => ({ ...prev, ["복지관 이용 현황"]: e.target.value }))
            }
            rows={4}
            aria-label="복지관 이용 현황"
            placeholder={
              "예) 평생교육 라인댄스 2025년부터 수강 중, 최근 환불 처리\n    심리상담 이용 (2026-03 ~ )\n    노인일자리 공원가꾸미 참여"
            }
            className="usebox w-full resize-none rounded border border-stone-400 p-2 text-[12.5px] leading-[1.9] text-foreground outline-none focus:border-stone-800 print:rounded-none print:text-black"
          />

          {/* 급식 쪽 핵심 숫자는 작게 한 줄로만. 자세한 것은 ④ 달력이 보여줍니다. */}
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground print:border-stone-400 print:text-black">
            <span>
              급식 등록일{" "}
              <b className="tabular-nums text-foreground print:text-black">
                {resident.registeredAt}
              </b>
            </span>
            <span>
              평소{" "}
              <b className="text-foreground print:text-black">
                {describeVisitFrequency(assessment.habitRate)}
              </b>
            </span>
            <span>
              최근 이용일{" "}
              <b className="tabular-nums text-foreground print:text-black">
                {lastAttendance ?? "기록 없음"}
              </b>
            </span>
            {assessment.consecutiveAbsence > 0 && (
              <span>
                연속 결석{" "}
                <b className="tabular-nums text-red-700 print:text-black">
                  {assessment.consecutiveAbsence}일
                </b>
              </span>
            )}
            {resident.resumeExpected && (
              <span>
                복귀 약속{" "}
                <b className="tabular-nums text-foreground print:text-black">
                  {resident.resumeExpected}
                </b>
              </span>
            )}
          </div>

          {/* ── ③ 위기 판단 ─────────────────────────────────── */}
          <SectionTitle n="③">위기 신호 등급 — 급식 출결 계산 결과</SectionTitle>
          <div className="mb-1.5 flex items-center gap-2">
            {/* ★ **가려지기 전 등급**을 씁니다.
                이 문서는 행정복지센터·사례관리팀으로 나갑니다. 사유를 확인해 잠시
                목록에서 빼 둔 분은 assessment.level 이 normal 이라, 뇌경색으로
                입원 중인 어르신의 의뢰서에 초록 「정상」이 인쇄됐습니다.
                잠시 빼 둔 것과 괜찮아진 것은 다릅니다. */}
            <RiskBadge level={assessment.levelBeforeSnooze ?? assessment.level} />
            <span className="text-[11px] text-muted-foreground print:text-black">
              {formatDateWithWeekday(DATA_END_STR)} 기준 · 출결 패턴과 외부변수로 판단
            </span>
          </div>
          <p className="text-[12px] leading-[1.7] text-foreground print:text-black">
            {assessment.narrative}
          </p>
          {assessment.reasons.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {assessment.reasons.map((r) => (
                <li
                  key={r}
                  className="rounded border border-stone-300 px-1.5 py-0.5 text-[10px] print:border-black"
                >
                  {r}
                </li>
              ))}
            </ul>
          )}

          {/* ── 여기부터 둘째 장 ──────────────────────────────
              종이 두 장은 흩어집니다. 받는 쪽 책상에서 둘째 장만 굴러다녀도 누구 것인지
              알 수 있게, 장마다 표시를 답니다. 화면에서는 보이지 않습니다. */}
          <p className="hidden pt-2 text-right text-[9px] text-black print:block">
            1 / 2 — 다음 장에 출석 기록과 담당자 의견이 이어집니다
          </p>
          <div className="page2" />
          <div className="hidden border-b border-black pb-1 text-[10px] text-black print:block">
            어르신 연계 의뢰서 (2 / 2) · {resident.name} · 회원번호 {resident.id} · 작성일{" "}
            {todayStr}
          </div>

          {/* ── ④ 출석 기록 (상세 화면의 달력을 종이에 맞게 압축) ──
              상세 화면은 한 달을 7칸짜리 달력으로 크게 보여줍니다. 그대로 옮기면 여섯 달이
              A4 반 장을 먹습니다. 받는 쪽이 이 칸에서 알아야 하는 것은 "언제부터 끊겼는가"
              하나라, 한 달을 한 줄로 눕히고 색만 남겼습니다. */}
          <SectionTitle n="④">출석 기록 — 최근 6개월</SectionTitle>
          <div className="mb-1.5 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground print:text-black">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-emerald-400" /> 오신 날
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-red-400" /> 안 오신 날
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-[2px] border border-stone-300 bg-stone-100" />{" "}
              문 닫은 날 · 기록 없음
            </span>
          </div>
          <div className="keep rounded border border-stone-300 px-2.5 py-1.5 print:border-black">
            {calendarMonths.map((m) => (
              <div
                key={`${m.year}-${m.month}`}
                className="flex items-center gap-2 border-b border-stone-200 py-1 last:border-0 print:border-stone-400"
              >
                <span className="w-16 shrink-0 text-[10px] tabular-nums text-muted-foreground print:text-black">
                  {m.year}.{String(m.month).padStart(2, "0")}
                </span>
                <span className="flex flex-1 flex-wrap gap-[2px]">
                  {m.days.map((cell) => (
                    <span
                      key={cell.day}
                      title={`${m.year}-${String(m.month).padStart(2, "0")}-${String(cell.day).padStart(2, "0")} · ${DAY_LABEL[cell.status]}`}
                      className={`inline-block h-[9px] w-[9px] rounded-[2px] ${DAY_COLOR[cell.status]}`}
                    />
                  ))}
                </span>
                <span className="w-24 shrink-0 text-right text-[10px] tabular-nums text-foreground print:text-black">
                  {m.totalCount > 0
                    ? `${m.presentCount}/${m.totalCount}일 · ${m.rate}%`
                    : "판단 제외"}
                </span>
              </div>
            ))}
          </div>

          {/* ── ⑤ 연락·확인 기록 ────────────────────────────── */}
          <SectionTitle n="⑤">연락 · 확인 기록</SectionTitle>
          {followups.length > 0 ? (
            <>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-stone-400 text-left text-[10px] text-muted-foreground print:text-black">
                    <th className="w-24 py-1 font-medium">확인일</th>
                    <th className="w-20 py-1 font-medium">담당자</th>
                    <th className="w-24 py-1 font-medium">결과</th>
                    <th className="py-1 font-medium">내용</th>
                  </tr>
                </thead>
                <tbody>
                  {/* 넉 건까지만. 더 실으면 A4 한 장을 넘어가고, 두 장이 되면 받는 쪽에서
                      한 장을 잃어버리기 쉽습니다. */}
                  {followups.slice(0, 4).map((f) => (
                    <tr key={f.id} className="border-b border-stone-200 print:border-stone-400">
                      <td className="py-1 align-top tabular-nums">{f.checkedAt}</td>
                      <td className="py-1 align-top">{f.staff}</td>
                      {/* ★ 갈래가 없으면 「–」만 찍혀, 받는 기관은 두 번 연락했다는
                          사실조차 못 읽었습니다. 갈래는 나중에 생긴 칸이라 그 전에
                          적은 기록에는 비어 있습니다. 그럴 때는 어르신 상세 화면과
                          같은 방식으로 outcome 에서 읽어 적습니다. */}
                      <td className="py-1 align-top">
                        {f.resultKind
                          ? (RESULT_KIND_META[f.resultKind]?.label ?? f.resultKind)
                          : f.outcome === "no_answer"
                            ? "부재중"
                            : f.outcome === "needed"
                              ? "도움이 더 필요"
                              : "지금은 괜찮으심"}
                      </td>
                      <td className="py-1 align-top leading-[1.6]">{f.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {followups.length > 4 && (
                <p className="fineprint mt-1 text-[10px] text-muted-foreground print:text-black">
                  가장 최근 4건만 실었습니다 (전체 {followups.length}건).
                </p>
              )}
            </>
          ) : (
            <div>
              <p className="fineprint mb-1 text-[10px] text-muted-foreground print:text-black">
                앱에 남은 연락 기록이 없습니다. 종이로 확인하신 내용이 있으면 아래에 적어주세요.
              </p>
              {[0, 1, 2].map((i) => (
                <div key={i} className="blankline py-2">
                  <Field w="100%" label={`연락 기록 ${i + 1}`} {...fld(`연락 기록 ${i + 1}`)} />
                </div>
              ))}
            </div>
          )}

          {/* ── ⑥ 담당자 의견 ───────────────────────────────── */}
          <SectionTitle n="⑥">담당자 의견 · 연계 요청 사항</SectionTitle>
          <p className="mb-1 text-[10px] text-muted-foreground print:hidden">
            위의 모든 칸과 이 칸은 <b>저장되지 않습니다</b> — 다 채우신 뒤 인쇄하거나 PDF로
            저장해주세요. 생년월일·주소·연락처를 브라우저에 남기지 않기 위해서입니다.
          </p>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={6}
            placeholder="예) 7월 중순부터 발길이 끊겨 세 차례 연락드렸으나 닿지 않았습니다. 이웃 말로는 거동이 불편해지셨다고 합니다. 가정방문과 돌봄 서비스 연계를 요청드립니다."
            className="commentbox w-full resize-none rounded border border-stone-400 p-2 text-[12px] leading-[1.9] text-foreground outline-none focus:border-stone-800 print:rounded-none print:text-black"
          />

          {/* ── 맺음 ────────────────────────────────────────── */}
          <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t-2 border-stone-800 pt-2 text-[11px] print:border-black print:text-black">
            <div>
              위 내용과 같이 연계를 의뢰합니다.
              <span className="ml-3 text-muted-foreground print:text-black">작성 부서</span>{" "}
              <Field w="6rem" label="작성 부서" {...fld("작성 부서")} />
              <span className="ml-3 text-muted-foreground print:text-black">작성자</span>{" "}
              <Field w="5rem" label="작성자" {...fld("작성자")} />
              <span className="ml-1 text-muted-foreground print:text-black">(인)</span>
            </div>
            <div className="text-muted-foreground print:text-black">
              춘천남부노인복지관장 <span className="ml-1">(직인)</span>
            </div>
          </div>

          <p className="fineprint mt-2 text-[9px] leading-relaxed text-muted-foreground print:text-black">
            이 문서에는 개인정보가 들어 있습니다. 연계 목적 외로 쓰지 마시고, 목적을 다한 뒤에는
            파기해주세요. 이용 현황·위기 판단은 기관의 식사 출결 기록으로 계산한 값이며, 의료적
            진단이 아닙니다.
          </p>
        </div>
      </div>
    </div>
  );
}
