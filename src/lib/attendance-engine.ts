// 이 파일이 판정 엔진입니다. 경로식당 출결 기록을 Supabase 에서 받아, 어르신 한 분 한 분의
// 결석을 「그분 평소 리듬에 견주어」 점수로 환산하고 긴급·위기·관심 등급을 매깁니다.
// 화면 21곳이 여기서 계산 결과를 가져다 씁니다.
//
// 이 파일에 어르신 자료는 한 줄도 들어 있지 않습니다. 명단은 Supabase 의 residents 표에서
// 받아 오고(loadData), 로그아웃하면 비웁니다. 지어낸 어르신을 만들던 코드는 실제 자료를
// 붙이면서 전부 걷어냈습니다 — 그 경위는 「위험등급 계산」 앞 주석에 남겨 두었습니다.
//
// (예전 이름은 mock-data.ts 였습니다. 프로토타입 시절의 이름이 내용과 정반대가 되어 있어
//  바꿨습니다 — 가짜 자료는 없고, 운영 중인 판정 로직입니다.)

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { supabase } from "./supabase-client";
import { describeWeather, getWeather, loadWeather } from "./weather";
import { loadFactorSettings } from "./factor-settings";
import { getMenu, loadMenus, getMenuEvent, getMenuNote } from "./menus";
import {
  FACTOR_META,
  detectReferenceFactors,
  getReferenceFactors,
  getRegularUserMinRate,
  getFestivalAdjacency,
  isFactorEnabled,
  recomputeFestivalAdjacency,
  recomputePensionWindow,
  type ReferenceFactor,
  type ReferenceFactorKind,
} from "./external-factors";

// ── 기본 타입 ──────────────────────────────────────────────

/**
 * 위험 등급.
 *
 * 「판단 어려움」(unknown)이 뒤늦게 들어왔습니다. 사양 7-1은 "tier == 관측불가 이면
 * level = 판단보류"라고 정해 두었는데, 이 타입에 그 칸이 없어서 **「정상」으로 흘러갔습니다.**
 * 급식을 한 달에 한두 번 드시는 분이 초록색 「정상」을 달고 있으면, 담당자는 그분을
 * 확인한 셈 치게 됩니다. 판단하지 않은 것과 괜찮은 것은 다릅니다.
 */
export type RiskLevel = "crisis" | "caution" | "concern" | "normal" | "unknown";
export const RISK_ORDER: RiskLevel[] = ["crisis", "caution", "concern", "normal", "unknown"];

/**
 * 등급 이름. **계산은 건드리지 않고 부르는 말만** 정한 자리입니다.
 *
 * 예전에는 crisis 를 「위기」, caution 을 「주의」라고 불렀습니다. 그런데 현장에서 주의
 * 단계부터 전화를 돌리기 시작하면서, 「주의」라는 말이 실제로 하는 일과 안 맞게 됐습니다 —
 * 이미 위험하다고 보고 연락하는 분께 「주의」는 너무 약한 말입니다. 그리고 「주의」와
 * 「관심」은 현장에서 소리 내어 읽으면 구분이 안 됩니다.
 *
 * 한 칸씩 올려 부릅니다. 문턱도 점수도 그대로이고, 부르는 말만 바뀝니다 —
 *   crisis  「긴급」      오늘 바로
 *   caution 「위기」      이번 주 안에
 *   concern 「관심」      전화 안 함. 급식에 오시면 자동으로 빠짐
 */
export const RISK_LABELS: Record<RiskLevel, string> = {
  crisis: "긴급",
  caution: "위기",
  concern: "관심",
  normal: "정상",
  unknown: "판단 어려움",
};

export const RISK_BADGE_STYLES: Record<RiskLevel, string> = {
  // 긴급은 **채워서** 그립니다. 연한 배지로는 한 줄 안에서 다른 칩들에 묻힙니다 —
  // 오늘 바로 걸어야 하는 분이 눈에 제일 먼저 들어와야 합니다.
  crisis: "bg-red-600 text-white hover:bg-red-600 border-red-700 font-bold shadow-sm",
  // 위기(옛 주의)는 한 칸 올라온 만큼 색도 올립니다. 연한 노랑이던 것을 진한 주황으로.
  caution: "bg-orange-100 text-orange-900 hover:bg-orange-100 border-orange-400 font-semibold",
  concern: "bg-blue-100 text-blue-800 hover:bg-blue-100 border-blue-200",
  normal: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200",
  // 흰 바탕 · 회색 글씨. 안심시키지도, 겁주지도 않습니다 — 아직 아무 말도 안 한 것입니다.
  unknown: "bg-white text-stone-600 hover:bg-white border-stone-300",
};

export const RISK_BAR_COLORS: Record<RiskLevel, string> = {
  crisis: "bg-red-400",
  caution: "bg-amber-400",
  concern: "bg-blue-400",
  normal: "bg-emerald-400",
  unknown: "bg-stone-300",
};

export type ResidentStatus = "active" | "discharged";

export interface Resident {
  id: string;
  name: string; // 가명 (3글자)
  ageGroup: string;
  phone: string;
  registeredAt: string;
  notes: string; // 특이사항
  status: ResidentStatus;
  photoUrl?: string; // 실제 사진 URL(없으면 일러스트 아바타로 대체)
  /**
   * 식사 이용 구분. 무료급식·감면은 수급·저소득에 해당하는 분들이라, 같은 정도로 발길이
   * 끊겼을 때 먼저 찾아뵐 근거가 됩니다. 경제적 형편에 관한 정보이므로 판단 근거로만 쓰고
   * 목록에 크게 붙여 어르신을 구분 짓는 표시로 쓰지 않습니다.
   */
  mealTier: "일반" | "감면" | "무료급식";
  /** AI가 붙인 "왜 위험한지" 한 줄 설명(없으면 아직 분석 전). */
  aiSummary?: string;
  /**
   * 다시 분석해야 하는 분인가.
   *
   * 확인 기록이 들어오면 데이터베이스 트리거가 이 값을 true 로 돌립니다(migration_017).
   * 담당자가 전화해서 뭔가 알아낸 순간이, 어제 쓴 설명이 낡는 순간입니다.
   */
  aiNeedsUpdate?: boolean;
  /**
   * 그 설명을 만든 날짜(YYYY-MM-DD).
   *
   * AI 문장은 **만든 순간의 자료와 설정으로 쓴 글**이고 그대로 저장됩니다. 그 뒤로
   * 어르신이 다시 나오시거나 외부변수 스위치를 바꿔도 문장은 그대로입니다. 언제 쓴
   * 글인지 안 보이면, 어제 기준 문장을 오늘 판단으로 읽게 됩니다.
   */
  aiSummaryAt?: string;
  attendance: Record<string, boolean>; // YYYY-MM-DD -> 출석여부
  /**
   * 감시 상태 (구현요청서 9장). DB에 저장된 값이고, 실제로 쓰는 값은
   * getMemberState() 가 출결까지 보고 계산한 쪽입니다 — 출석이 들어오면 보류가
   * 자동으로 풀려야 하는데, 그걸 사람이 눌러줘야 하면 결국 안 눌립니다.
   */
  watchStatus: WatchStatus;
  /** "추석 이후 나오신대요" 같은 약속. 이 날이 지나도 안 나오시면 그게 신호입니다. */
  resumeExpected: string | null;
  /** 기준선 하향 갱신 누적 횟수. 2회 이상이면 쇠약의 궤적으로 봅니다(9-5). */
  downgradeCount: number;
}

/** 감시중: 매일 판정 · 보류: 판정 중단(출석 1건이면 자동 해제) · 종료: 자동 해제 없음 */
export type WatchStatus = "감시중" | "보류" | "종료";

/** 확인 결과 분류 (8-1 프롬프트의 result 값). */
export type ResultKind =
  | "위기"
  | "사망"
  | "요양원입소"
  | "이사전출"
  | "급식자격상실"
  | "타기관이용"
  | "일자리프로그램참여"
  | "일시적사정"
  | "이용감소"
  | "확인불가";

/**
 * 확인 결과 → 상태 전이표 (구현요청서 9-2).
 *
 * "확인불가"가 감시중으로 남는 것이 핵심입니다. **연락이 안 되는 것 자체가 위기 신호**라서
 * 해제 사유가 될 수 없습니다(실제 확인 27명 중 8명이 연락 불가였고 97세 독거 어르신도
 * 포함돼 있었습니다).
 */
export const RESULT_KIND_META: Record<
  ResultKind,
  { label: string; status: WatchStatus; hint: string; needsResumeDate?: boolean }
> = {
  // label 을 「실제 위기 발생」으로 적습니다. 등급 이름이 바뀌면서 등급 「위기」(이번 주
  // 안에 확인)와 결과 「위기」(입원·낙상이 실제로 일어남)가 대시보드 같은 줄에 나란히
  // 뜨게 됐습니다. 같은 두 글자가 한 화면에서 다른 뜻이면 담당자가 매번 헷갈립니다.
  위기: {
    label: "실제 위기 발생 (입원·낙상·질환)",
    status: "보류",
    hint: "사례관리로 연계하세요",
  },
  사망: { label: "사망", status: "종료", hint: "명단에서 앞으로 확인 대상에서 제외됩니다" },
  요양원입소: {
    label: "요양원 입소",
    status: "종료",
    hint: "명단에서 앞으로 확인 대상에서 제외됩니다",
  },
  이사전출: {
    label: "이사·전출",
    status: "종료",
    hint: "명단에서 앞으로 확인 대상에서 제외됩니다",
  },
  급식자격상실: { label: "급식 자격 상실", status: "종료", hint: "급식으로 볼 수 없게 된 분" },
  타기관이용: {
    label: "타 기관 이용 (경로당 등)",
    status: "종료",
    hint: "다른 곳에서 뵙고 계십니다",
  },
  일자리프로그램참여: {
    label: "노인일자리·프로그램 참여",
    status: "보류",
    hint: "사업이 끝나면 돌아오십니다",
  },
  일시적사정: {
    label: "일시적 사정 (더위·개인사정)",
    status: "보류",
    hint: "언제쯤 나오실지 적어두면 그날 자동으로 다시 뜹니다",
    needsResumeDate: true,
  },
  이용감소: {
    label: "덜 오시게 됨 (건강 악화 등)",
    status: "감시중",
    hint: "평소 기준을 새 리듬으로 다시 잡습니다",
  },
  확인불가: {
    label: "확인 불가 (연락 안 됨)",
    status: "감시중",
    hint: "연락이 안 되는 것 자체가 신호라 목록에 그대로 둡니다",
  },
};

// ── 날짜 유틸 ──────────────────────────────────────────────

const WEEKDAY_LABELS_KR = ["일", "월", "화", "수", "목", "금", "토"] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDateStr(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d: Date, delta: number): Date {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + delta);
  return nd;
}

// 기관은 주말에 운영하지 않으므로, 토·일요일은 어디서든 "운영일"로 세지 않습니다.
function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

export function formatDateWithWeekday(dateStr: string): string {
  const d = parseDateStr(dateStr);
  return `${dateStr} (${WEEKDAY_LABELS_KR[d.getDay()]})`;
}

export function getWeekdayLabel(dayIndex: number): string {
  return WEEKDAY_LABELS_KR[dayIndex];
}

// 실제 접속 시각(new Date())을 기준으로 삼으면 매일, 심지어 서버를 재시작할 때마다 데이터 범위가
// 달라져서 이름·메모·출석 패턴이 계속 바뀌어 버립니다. 그래서 "오늘"을 실제 시계가 아니라 이
// 고정된 날짜로 못박아, 몇 번을 새로고침/재시작해도 동일한 기준일이 나오도록 합니다.
// 실제 자료 기간입니다. 차상위 코호트 396명 기준, 2025년 1월 ~ 2026년 8월.
// 겹치는 276명에게는 2025 기록을 붙여 기준선을 늘렸습니다(요일이동·겨울 계수용).
// 리모델링 밀키트 기간과 2025-04-07~11 일괄발권 오류는 제외했습니다.
// 아래 값은 **자료를 불러온 뒤 실제 기록 범위로 갱신**됩니다(applyDataRange).
// 여기 적힌 날짜는 자료가 아직 없을 때 쓰는 초기값일 뿐입니다.
//
// 예전에는 마지막 기록일을 2026-08-28로 코드에 박아두었습니다. 목업 자료를 고정하려던
// 것인데, 실제 자료를 쓰기 시작하면서 심각한 문제가 됐습니다 — 9월 자료를 새로 넣어도
// 앱이 전부 8월 28일로 잘라내어(clampToRange·getDayDetail) **새 자료가 분석에 하나도
// 반영되지 않았습니다.** 자료 범위는 자료가 정해야 합니다.
const DATA_START = new Date(2025, 0, 2);
const DATA_END_DATE = new Date(2026, 7, 28);

export let DATA_START_STR = toDateStr(DATA_START);
export let DATA_END_STR = toDateStr(DATA_END_DATE);
// 앱 전체에서 "오늘"이 필요할 때는 new Date() 대신 이 값을 씁니다(자료의 마지막 날).
export const TODAY_DATE = new Date(DATA_END_DATE);

/** 실제 달력의 오늘(YYYY-MM-DD). 자료 기준일과 다릅니다. */
export function realTodayStr(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/**
 * 지금 보고 있는 화면에서 확인 기록을 **어느 날짜로** 남길지.
 *
 * 담당자는 8월 위기 명단을 띄워 놓고 전화를 돌립니다. 그런데 기록은 언제나 오늘
 * 날짜로 들어갔습니다 — 8월 화면으로 돌아가면 방금 적은 것이 없습니다. 「연락 드린 분
 * 0명」이 그대로고, 같은 분께 또 전화하게 됩니다.
 *
 *   9월(최신 자료) 보는 중  → 오늘 날짜. 자료는 어제까지여도 전화는 오늘 걸었습니다.
 *   8월 보는 중             → 8월의 기준일. 그 달 판정에 대한 확인이니까요.
 *
 * 실제로 **언제 입력했는지**는 따로 남습니다(Followup.recordedAt / created_at).
 * 둘은 다른 것을 뜻합니다 — checkedAt 은 "어느 시점 판정에 대한 답인가",
 * recordedAt 은 "언제 자판을 두드렸나".
 */
export function recordDateFor(asOfStr: string): string {
  return clampAsOf(asOfStr) >= DATA_END_STR ? realTodayStr() : clampAsOf(asOfStr);
}

/**
 * 확인 기록을 어느 날짜까지 인정할지.
 *
 * 급식 자료는 하루 늦게 들어옵니다. 담당자는 **오늘** 전화하고 **오늘** 적는데, 판정은
 * **어제** 자료 위에 서 있습니다. 확인 기록을 자료 기준일로 남기면 "어제 적은 것"으로
 * 보이고, 반대로 오늘 날짜로 남기면 판정이 그 기록을 **못 보게** 됩니다 —
 * 판정 쪽 필터가 전부 `checkedAt <= 자료기준일` 이었기 때문입니다.
 *
 * 그래서 기록은 **적은 날(오늘)** 로 남기고, 판정은 최신 자료를 보고 있을 때에 한해
 * **오늘까지의 기록을 인정**합니다. 지난 달을 되짚어 볼 때는 그때까지만 인정합니다 —
 * 과거 화면에 미래의 확인 결과가 섞이면 그때의 판단을 되짚을 수 없습니다.
 */
/**
 * 기준일을 **자료가 있는 마지막 날**로 자릅니다.
 *
 * 화면은 「조회한 달의 말일」을 기준일로 넘기곤 합니다. 이번 달을 보고 있으면 그 날짜가
 * 아직 오지 않았는데도요. 그러면 계산이 **미래를 오늘로 알고** 돌아갑니다 —
 *
 *   화면 머리말: 2026-09-15 (화) 기준
 *   실제 비교:   2026-09-30 (조회 월의 말일)
 *   → 복귀 예정일 09-28 < 09-30  →  「나오신다고 하신 날이 지났습니다」
 *   → 9월 17일에, 아직 열흘 남은 약속을 두고.
 *
 * 예전에는 getAiRiskAssessment 한 곳에서만 잘랐고, asOfStr 을 그대로 받는 나머지는
 * 전부 월말을 오늘로 알았습니다. 호출하는 쪽마다 기억해서 자르게 두면 언젠가 또
 * 빠뜨립니다. **엔진 입구에서 한 번에 막습니다.**
 */
export function clampAsOf(asOfStr: string): string {
  return asOfStr > DATA_END_STR ? DATA_END_STR : asOfStr;
}

export function followupCutoff(asOfStr: string): string {
  asOfStr = clampAsOf(asOfStr);
  if (asOfStr < DATA_END_STR) return asOfStr;
  const today = realTodayStr();
  return today > asOfStr ? today : asOfStr;
}

/**
 * 출결 기록에서 실제 자료 범위를 읽어 반영합니다.
 *
 * Date 개체를 새로 만들지 않고 **제자리에서 고칩니다**. 화면 코드 중에 모듈을 읽는 시점에
 * `const today = TODAY_DATE` 처럼 값을 붙잡아 두는 곳이 있어서, 새 개체로 바꿔치우면 그런
 * 곳만 옛 날짜를 계속 보게 됩니다.
 */
function applyDataRange(dates: string[]): void {
  if (dates.length === 0) return;
  let minStr = dates[0];
  let maxStr = dates[0];
  for (const d of dates) {
    if (d < minStr) minStr = d;
    if (d > maxStr) maxStr = d;
  }
  const setTo = (target: Date, ds: string) => {
    const [y, m, d] = ds.split("-").map(Number);
    target.setHours(0, 0, 0, 0);
    target.setFullYear(y, m - 1, d);
  };
  setTo(DATA_START, minStr);
  setTo(DATA_END_DATE, maxStr);
  setTo(TODAY_DATE, maxStr);
  DATA_START_STR = minStr;
  DATA_END_STR = maxStr;
}

function clampToRange(d: Date): Date {
  if (d < DATA_START) return DATA_START;
  if (d > DATA_END_DATE) return DATA_END_DATE;
  return d;
}

// ── 기관 상수 ────────────────────────────────────────────────

// 담당 직원. 처음 화면을 열었을 때 비어 있지 않도록 두는 초기값이고, 실제로는 Supabase의
// staff 표에서 불러옵니다(관리자 화면에서 추가·삭제).
// 비워 둡니다. 예전에는 실제 담당자 네 분의 이름을 여기 적어 두었는데, 이 값은 로그인
// 하지 않은 사람도 브라우저 번들에서 그대로 읽을 수 있습니다. 동료 이름을 공개 저장소에
// 올릴 이유가 없고, 아래 1233행이 staff 표를 받아 어차피 덮어씁니다.
const SEED_STAFF_MEMBERS: string[] = [];
export let STAFF_MEMBERS: string[] = [...SEED_STAFF_MEMBERS];
export const AGE_GROUPS = ["70대 초반", "70대 후반", "80대 초반", "80대 후반", "90대 초반"];

// ── 위험등급 계산 ──────────────────────────────────────────────
//
// 예전에는 이 파일에 어르신 50명을 지어내는 코드가 함께 있었습니다(가명·전화번호·출결·메모를
// 난수로 만들었습니다). 실제 자료를 넣으면서 전부 걷어냈습니다 — 지어낸 자료를 만들 수 있는
// 코드가 남아 있으면, 언젠가 실제 자료와 섞여도 아무도 알아채지 못합니다.

export function computeRiskLevelFromRate(rate: number): RiskLevel {
  if (rate < 50) return "crisis";
  if (rate < 70) return "caution";
  if (rate < 85) return "concern";
  return "normal";
}

export let residents: Resident[] = [];

export function getResidentById(id: string): Resident | undefined {
  return residents.find((r) => r.id === id);
}

// 퇴소하지 않은(현재 서비스 중인) 어르신만. 대시보드·출석·메모·분석 등 "운영 중" 화면과 통계는
// 전부 이 함수를 기준으로 계산해, 퇴소한 어르신이 현재 통계에 계속 잡히지 않도록 합니다.
/**
 * 자료가 성한 어르신만 판정에 씁니다.
 *
 * 실제로 회원번호 자리에 날짜가 들어간 기록이 생겼습니다 —
 * "Wed Nov 01 2023 00:00:00 GMT+0900". 엑셀에서 열이 밀리거나 빈 칸이 있을 때 생깁니다.
 * 이런 분을 그대로 판정에 넣으면 두 가지가 나빠집니다.
 *   · 위기로 떠도 **엔컴에서 조회할 수 없어** 담당자가 확인할 방법이 없습니다
 *   · 명부 인원·출석률 같은 모든 숫자에 유령이 섞입니다
 *
 * ★ 다만 **판정에서만 빼고 명부에서 지우지는 않습니다.** 조용히 사라지면 아무도 고치지
 *   않습니다. 관리자 → 자료 점검에 크게 띄워 두고, 고쳐지면 자동으로 다시 들어옵니다.
 */
export function getActiveResidents(): Resident[] {
  return residents.filter((r) => r.status === "active" && blockingIssue(r) === null);
}

/**
 * 명부에 올라 있는 어르신 수 — **자료가 깨진 분까지 포함한 전체**입니다.
 *
 * getActiveResidents().length 와 다릅니다. 그쪽은 blockingIssue 가 걸린 분을 빼고,
 * 이쪽은 넣습니다. 통계 화면의 「전체 명부 N명」이 이 수이고, 대시보드의 「N월 등록
 * 어르신」은 저쪽 수라, **두 화면에 다른 숫자가 뜹니다.** 틀린 게 아니라 다른 것을
 * 세는 것인데, 화면이 그 사정을 말해 주지 않으면 보는 사람은 둘 중 하나가 틀렸다고
 * 여깁니다. 실제로 저희가 먼저 헷갈렸습니다. 그래서 대시보드가 "몇 명이 왜 빠졌는지"를
 * 함께 적을 수 있도록 두 수를 모두 내어 줍니다.
 */
export function getRosterTotal(): number {
  return residents.length;
}

/** 회원번호·이름이 깨져 판정에서 통째로 빠지는 분 수. 대시보드 모수에서 제외됩니다. */
export function getBlockedCount(): number {
  return residents.filter((r) => r.status === "active" && blockingIssue(r) !== null).length;
}

/** 판정에 넣을 수 없는 자료 문제. 없으면 null. */
function blockingIssue(r: Resident): { kind: DataIssueKind; detail: string } | null {
  if (!VALID_MEMBER_ID.test(r.id))
    return {
      kind: "회원번호 오류",
      detail: `회원번호가 'YYYY-NNNNN' 모양이 아닙니다: ${r.id.slice(0, 48)}`,
    };
  if (!r.name.trim())
    return { kind: "이름 없음", detail: "이름이 비어 있어 누구인지 알 수 없습니다" };
  return null;
}

/** 엔컴 회원번호 모양 (가져오기 쪽 encom-import.ts 와 같은 기준). */
const VALID_MEMBER_ID = /^\d{4}-\d{3,7}$/;

export type DataIssueKind =
  | "회원번호 오류"
  | "이름 없음"
  | "등록일 이상"
  | "출결 없음"
  | "구분 미상";

export interface DataIssue {
  residentId: string;
  name: string;
  kind: DataIssueKind;
  detail: string;
  /** blocking = 판정에서 뺌 · warn = 판정에는 넣되 확인 필요 */
  severity: "blocking" | "warn";
  /** 담당자가 "봤고 문제없다"고 눌러 접어둔 건. 목록에서는 기본으로 안 보입니다. */
  checked: boolean;
  checkedBy?: string;
  checkedAt?: string;
}

// ── "이 건은 봤습니다" 표시 ───────────────────────────────────
//
// 목록에 뜨는 것 중에는 고칠 게 없는 것이 섞여 있습니다("첫 방문이 등록일보다 앞섭니다"는
// 과거 자료를 나중에 넣으면 당연히 생깁니다). 그런데 안 사라지니 열어볼 때마다 같은 줄을
// 다시 읽고 다시 판단하게 되고, 몇 번 반복되면 목록 전체를 안 보게 됩니다 — 그 안에 진짜
// 문제가 섞여 있어도요. 지우는 게 아니라 접어두는 것이라 언제든 되돌릴 수 있습니다.
const ISSUE_CHECKS = new Map<string, { by: string; at: string }>();
const issueKey = (residentId: string, kind: string) => `${residentId}::${kind}`;

export async function loadDataIssueChecks(): Promise<void> {
  const { data, error } = await supabase.from("data_issue_checks").select("*");
  if (error) {
    // 표가 아직 없을 수 있습니다(migration_024 미실행). 그때는 전부 "확인 안 함"으로 둡니다 —
    // 문제를 숨기는 쪽이 아니라 보여주는 쪽으로 틀리는 것이 맞습니다.
    console.warn(
      "자료 점검 확인 표시를 읽지 못했습니다(migration_024 미실행일 수 있음).",
      error.message,
    );
    return;
  }
  ISSUE_CHECKS.clear();
  for (const row of data ?? []) {
    ISSUE_CHECKS.set(issueKey(row.resident_id, row.kind), {
      by: row.checked_by ?? "",
      at: String(row.checked_at ?? "").slice(0, 10),
    });
  }
}

/** "봤습니다" 표시. 되돌리려면 checked=false 로 부릅니다. */
export async function setDataIssueChecked(
  residentId: string,
  kind: string,
  checked: boolean,
  staffName: string,
): Promise<{ ok: boolean; error: string | null }> {
  if (checked) {
    const { error } = await supabase.from("data_issue_checks").upsert(
      {
        resident_id: residentId,
        kind,
        checked_by: staffName,
        checked_at: new Date().toISOString(),
      },
      { onConflict: "resident_id,kind" },
    );
    if (error) return { ok: false, error: error.message };
    ISSUE_CHECKS.set(issueKey(residentId, kind), {
      by: staffName,
      at: new Date().toISOString().slice(0, 10),
    });
  } else {
    const { error } = await supabase
      .from("data_issue_checks")
      .delete()
      .eq("resident_id", residentId)
      .eq("kind", kind);
    if (error) return { ok: false, error: error.message };
    ISSUE_CHECKS.delete(issueKey(residentId, kind));
  }
  notify();
  return { ok: true, error: null };
}

/**
 * 자료 점검 — 손봐야 할 기록을 모읍니다.
 *
 * 자료는 엑셀에서 들어오고, 엑셀은 사람이 뽑습니다. 열이 밀리거나 빈 칸이 생기는 일은
 * 반드시 일어납니다. 중요한 것은 **그게 일어났을 때 눈에 띄는가**입니다.
 */
export function getDataIssues(): DataIssue[] {
  const out: DataIssue[] = [];
  const today = DATA_END_STR;
  for (const r of residents) {
    if (r.status !== "active") continue;
    const blocking = blockingIssue(r);
    if (blocking) {
      out.push({
        residentId: r.id,
        name: r.name || "(이름 없음)",
        kind: blocking.kind,
        detail: blocking.detail,
        severity: "blocking",
        checked: false,
      });
      continue; // 이미 판정에서 빠졌으므로 다른 점검은 의미가 없습니다
    }
    const came = Object.keys(r.attendance).filter((d) => r.attendance[d]);
    if (came.length === 0) {
      out.push({
        residentId: r.id,
        name: r.name,
        kind: "출결 없음",
        detail: "명부에는 있는데 오신 기록이 한 번도 없습니다",
        severity: "warn",
        checked: false,
      });
    }
    if (r.registeredAt > today) {
      out.push({
        residentId: r.id,
        name: r.name,
        kind: "등록일 이상",
        detail: `등록일(${r.registeredAt})이 자료의 마지막 날(${today})보다 뒤입니다`,
        severity: "warn",
        checked: false,
      });
    } else if (came.length > 0 && came.sort()[0] < r.registeredAt) {
      out.push({
        residentId: r.id,
        name: r.name,
        kind: "등록일 이상",
        detail: `첫 방문(${came[0]})이 등록일(${r.registeredAt})보다 앞섭니다 — 과거 자료를 나중에 넣으면 생깁니다`,
        severity: "warn",
        checked: false,
      });
    }
    if (!["일반", "감면", "무료급식"].includes(r.mealTier)) {
      out.push({
        residentId: r.id,
        name: r.name,
        kind: "구분 미상",
        detail: `이용 구분이 '${r.mealTier}'입니다 — 급식비가 바뀌면 생깁니다`,
        severity: "warn",
        checked: false,
      });
    }
  }
  const order = { blocking: 0, warn: 1 } as const;
  return out
    .map((i) => {
      const c = ISSUE_CHECKS.get(issueKey(i.residentId, i.kind));
      return c ? { ...i, checked: true, checkedBy: c.by, checkedAt: c.at } : i;
    })
    .sort(
      (a, b) => order[a.severity] - order[b.severity] || a.residentId.localeCompare(b.residentId),
    );
}

// ── 외부요인(공휴일·기관 전체 결석 급증일) 필터링 ──────────────────────
//
// "이 어르신만 결석한 날"과 "그날은 다들 결석한 날"을 구분하지 않으면, 공휴일이나 폭설·폭우 같은
// 외부요인 때문에 생긴 결석까지 그 어르신 개인의 위험 신호로 잘못 반영될 수 있습니다. 그래서
// (1) 알려진 공휴일과 (2) 기관 전체 출석률이 평소보다 큰 폭으로 떨어진 날을 통계적으로 찾아내
// "외부요인으로 설명되는 날"로 분류하고, 개인별 출석 패턴(기준선·최근 추이·연속결석) 계산에서는
// 이 날들을 아예 제외합니다.

// 2025~2026년 관공서 공휴일 + 대체공휴일. 여기 등록된 날짜는 "기관 전체가 쉰 날"로 보고
// 개인별 위험도 계산(출석률·연속결석·최근 30일)에서 제외합니다. 빠지면 그날 결석이 개인
// 책임으로 잡혀 멀쩡한 어르신이 위기군으로 올라옵니다.
//
// 실제 값은 Supabase의 holidays 표에서 불러오며(어드민 화면에서 추가·삭제 가능), 아래 목록은
// 로드 전에도 계산이 맞도록 둔 기본값입니다. 두 곳이 어긋나지 않게 supabase/
// migration_007_holidays_2025_2026.sql 과 같은 내용을 유지해주세요.
//
// 대체공휴일 규칙이 공휴일 종류마다 다릅니다:
//   · 삼일절·어린이날·부처님오신날·광복절·개천절·한글날·성탄절 → 토 또는 일과 겹치면 대체
//   · 설날·추석 연휴 → 일요일이나 다른 공휴일과 겹칠 때만 대체 (토요일은 해당 없음)
//   · 현충일 → 대체 대상이 아님
// 근로자의날(5/1)은 관공서 공휴일은 아니지만 기관이 휴관하므로 함께 넣었습니다.
export let HOLIDAY_LABELS = new Map<string, string>([
  // 2025년
  ["2025-01-01", "신정"],
  ["2025-01-27", "임시공휴일 (설 연휴 확대)"],
  ["2025-01-28", "설날 연휴"],
  ["2025-01-29", "설날"],
  ["2025-01-30", "설날 연휴"],
  ["2025-03-01", "삼일절 (토)"],
  ["2025-03-03", "대체공휴일 (삼일절)"],
  ["2025-05-01", "근로자의날 (기관 휴관)"],
  ["2025-05-05", "어린이날·부처님오신날"],
  ["2025-05-06", "대체공휴일 (부처님오신날)"],
  ["2025-06-03", "제21대 대통령선거"],
  ["2025-06-06", "현충일"],
  ["2025-08-15", "광복절"],
  ["2025-10-03", "개천절"],
  ["2025-10-05", "추석 연휴 (일)"],
  ["2025-10-06", "추석"],
  ["2025-10-07", "추석 연휴"],
  ["2025-10-08", "대체공휴일 (추석)"],
  ["2025-10-09", "한글날"],
  ["2025-12-25", "성탄절"],
  // 2026년
  ["2026-01-01", "신정"],
  ["2026-02-16", "설날 연휴"],
  ["2026-02-17", "설날"],
  ["2026-02-18", "설날 연휴"],
  ["2026-03-01", "삼일절 (일)"],
  ["2026-03-02", "대체공휴일 (삼일절)"],
  ["2026-05-01", "근로자의날 (기관 휴관)"],
  ["2026-05-05", "어린이날"],
  ["2026-05-24", "부처님오신날 (일)"],
  ["2026-05-25", "대체공휴일 (부처님오신날)"],
  ["2026-06-03", "제9회 전국동시지방선거"],
  ["2026-06-06", "현충일 (토·대체 없음)"],
  ["2026-07-17", "제헌절 (2026년 재지정)"],
  ["2026-08-15", "광복절 (토)"],
  ["2026-08-17", "대체공휴일 (광복절)"],
  ["2026-09-24", "추석 연휴"],
  ["2026-09-25", "추석"],
  ["2026-09-26", "추석 연휴 (토·대체 없음)"],
  ["2026-10-03", "개천절 (토)"],
  ["2026-10-05", "대체공휴일 (개천절)"],
  ["2026-10-09", "한글날"],
  ["2026-12-25", "성탄절"],
]);

function computeExternallyExplainedDates(): Set<string> {
  // 주말은 애초에 운영일이 아니므로(=모두 데이터 없음) 평균 계산에서 제외한다.
  // 퇴소한 어르신은 기관 운영 현황과 무관하므로 평균 계산에서도 제외한다.
  const active = getActiveResidents();
  const dayRates: { date: string; rate: number }[] = [];
  // 운영일만 봅니다. 예전에는 주말이 아닌 날을 전부 훑었는데, 그러면 기관이 문을 닫았던
  // 날까지 "그날 아무도 안 왔다"로 잡혀 결석 급증일이 됩니다.
  for (const dateStr of OPERATING_DAYS) {
    let present = 0;
    for (const r of active) if (r.attendance[dateStr]) present++;
    dayRates.push({ date: dateStr, rate: active.length ? (present / active.length) * 100 : 0 });
  }
  const overallAvg = dayRates.length
    ? dayRates.reduce((s, d) => s + d.rate, 0) / dayRates.length
    : 0;
  const anomalyThreshold = overallAvg - 15; // 평소보다 15%p 이상 낮으면 전체적 이상일로 간주

  const result = new Set<string>(HOLIDAY_LABELS.keys());
  // 기관 전체가 유독 안 나온 날. 이걸 따로 기록해두지 않으면, 아래에서 참고 요인으로 뺀
  // 날까지 "전체 결석 급증"이라는 엉뚱한 이름으로 화면에 나옵니다.
  const anomalies = new Set<string>();
  for (const d of dayRates) {
    if (d.rate < anomalyThreshold) {
      anomalies.add(d.date);
      result.add(d.date);
    }
  }
  ANOMALY_DATES = anomalies;

  // ── 참고 외부변수(장날·기초연금·비·명절 전후 등)는 운영일에서 빼지 않습니다. ──
  //
  // 구현요청서(4년치 검증) 결론: 이 변수들은 출석에 유의미한 영향이 없어(전부 3%p 미만)
  // "무효 확정"입니다. 유일하게 유효한 겨울(1월·12·2월)만 엔진에서 계절 반영 계수로 반영하고
  // (seasonalP), 명절 전후는 절벽위험 점수 계산을 건너뛰는 방식(classifyRisk)으로 처리합니다.
  // 날을 통째로 빼면 "하필 그날부터 안 나오기 시작한 어르신"이 가려지므로, 제외는 실제
  // 문을 닫은 날(공휴일·리모델링·데이터 이상)에만 씁니다.

  return result;
}

// ── 운영일 ────────────────────────────────────────────────
//
// 실제 자료에는 **오신 날만** 들어 있습니다. 안 오신 날까지 한 줄씩 넣으면 2,828명 ×
// 122일 = 21만 행이 되는데, 그중 17만 행이 "안 오셨다"입니다. 없는 것을 적어두느라
// 휴대폰에서 21만 행을 내려받게 할 수는 없습니다.
//
// 그래서 "운영일인데 기록이 없으면 결석"으로 읽습니다. 운영일은 따로 관리하지 않고
// 자료에서 도출합니다 — 그날 오신 분이 한 명이라도 있으면 문을 연 날입니다. 하루 평균
// 340분이 오시므로 이 판정이 틀릴 여지는 없습니다.
//
// 이 방식의 이점이 하나 더 있습니다. 리모델링 휴관처럼 기관이 안 열었던 날은 애초에
// 목록에 없으므로, 그 기간이 "전원 결석"으로 잡히는 일이 생기지 않습니다.
export let OPERATING_DAYS: string[] = [];
let OPERATING_DAY_SET = new Set<string>();

// 운영 방식이 평소와 달랐던 기간(리모델링 휴관 중 도시락 주 1회 배부 등).
// 기준선 계산에서 뺍니다 — 아래 setOperatingDays 설명 참고.
let REDUCED_OPERATION = new Set<string>();

// ── 정제 파이프라인 (구현요청서 3장) ────────────────────────────
//
// 운영일을 자료에서 알아내되, **사양에 적힌 규칙으로만** 거릅니다. 예전에는 "앞뒤 2주 안에
// 운영일이 8일 미만이면 평소와 다른 시기"라는 자체 규칙을 썼는데, 사양에 없는 규칙이었고
// 실제로 사고를 냈습니다 — 9월 1~9일 자료가 아직 안 들어왔다는 이유만으로 정상 운영한
// 9월 10·11·14일까지 통째로 판정에서 빠졌고, 그 사이 돌아오신 어르신이 "23일째 결석"으로
// 남았습니다. 자료가 덜 들어온 것과 기관이 다르게 운영한 것은 다릅니다.

/** STEP 1 — 리모델링 기간 밀키트 배부. 급식이 아니므로 통째로 제외합니다. */
const MEAL_KIT_FROM = "2025-12-01";
const MEAL_KIT_TO = "2026-03-10";

/** STEP 4 — 이 인원 미만인 날은 오류일로 봅니다(정상 운영 333일 중 해당 0일). */
const ERROR_DAY_MIN_USERS = 20;

/** STEP 3 — 일괄 발권 주간 판정. 주 이용 인원과 5일 개근 비율이 둘 다 높으면 일괄 발권. */
const BULK_WEEK_MIN_USERS = 50;
const BULK_WEEK_PERFECT_RATIO = 0.6;

function mondayOf(dateStr: string): string {
  const d = parseDateStr(dateStr);
  const wd = d.getDay(); // 0=일
  const back = wd === 0 ? 6 : wd - 1;
  return toDateStr(addDays(d, -back));
}

/**
 * 출결 기록에서 운영일을 확정합니다.
 *
 * 거르는 날은 REDUCED_OPERATION 에 모읍니다(기준선·점수 계산에서 건너뜁니다). 운영일 목록
 * 자체에서는 빼지 않습니다 — 화면에서 "자료는 있는데 판정에서 빠진 날"로 보여줘야 담당자가
 * "자료를 넣었는데 왜 안 바뀌지?"라고 묻지 않습니다.
 */
function setOperatingDays(rows: { date: string; resident_id: string }[]) {
  const byDate = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = byDate.get(r.date);
    if (!set) byDate.set(r.date, (set = new Set()));
    set.add(r.resident_id);
  }
  OPERATING_DAY_SET = new Set(byDate.keys());
  OPERATING_DAYS = [...OPERATING_DAY_SET].sort();

  const excluded = new Set<string>();

  for (const d of OPERATING_DAYS) {
    // STEP 1 — 밀키트 기간
    if (d >= MEAL_KIT_FROM && d <= MEAL_KIT_TO) excluded.add(d);
    // STEP 4 — 오류일(이용 인원이 너무 적은 날). 자료가 덜 들어온 날이 여기 걸립니다.
    if ((byDate.get(d)?.size ?? 0) < ERROR_DAY_MIN_USERS) excluded.add(d);
  }

  // STEP 3 — 일괄 발권 주간. 그 주에 5일 모두 나온 사람 비율이 비정상적으로 높으면
  // 사람이 다 온 것이 아니라 한꺼번에 발권한 것입니다(실제 2025-04-07~11: 179명 개근).
  const weeks = new Map<string, string[]>();
  for (const d of OPERATING_DAYS) {
    const wk = mondayOf(d);
    (weeks.get(wk) ?? weeks.set(wk, []).get(wk)!).push(d);
  }
  for (const [, daysOfWeek] of weeks) {
    if (daysOfWeek.length < 5) continue;
    const seen = new Map<string, number>();
    for (const d of daysOfWeek) {
      for (const id of byDate.get(d) ?? []) seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    if (seen.size < BULK_WEEK_MIN_USERS) continue;
    let perfect = 0;
    for (const [, n] of seen) if (n >= daysOfWeek.length) perfect++;
    if (perfect / seen.size >= BULK_WEEK_PERFECT_RATIO) {
      for (const d of daysOfWeek) excluded.add(d);
    }
  }

  REDUCED_OPERATION = excluded;
}

/**
 * 분석에서 뺀 날과 **그 이유**.
 *
 * 화면에 "분석 제외"라고만 적어두면 담당자는 왜 뺐는지 알 수 없고, 알 수 없으면 믿지
 * 않습니다. 어떤 규칙에 걸렸는지 날짜별로 그대로 보여줍니다(구현요청서 3장).
 */
export type ExclusionReason = "밀키트" | "오류일" | "일괄발권" | "공휴일" | "결석급증";

export function getExcludedDays(): { date: string; reason: ExclusionReason; users: number }[] {
  const out: { date: string; reason: ExclusionReason; users: number }[] = [];
  const active = getActiveResidents();
  const usersOn = (ds: string) => {
    let n = 0;
    for (const r of active) if (r.attendance[ds]) n++;
    return n;
  };
  for (const d of OPERATING_DAYS) {
    if (!REDUCED_OPERATION.has(d)) continue;
    const users = usersOn(d);
    const reason: ExclusionReason =
      d >= MEAL_KIT_FROM && d <= MEAL_KIT_TO
        ? "밀키트"
        : users < ERROR_DAY_MIN_USERS
          ? "오류일"
          : "일괄발권";
    out.push({ date: d, reason, users });
  }
  // 공휴일·기관 전체 결석 급증일도 기회일에서 빠지므로 함께 보여줍니다.
  for (const d of OPERATING_DAYS) {
    if (REDUCED_OPERATION.has(d) || !EXTERNALLY_EXPLAINED_DATES.has(d)) continue;
    out.push({
      date: d,
      reason: HOLIDAY_LABELS.has(d) ? "공휴일" : "결석급증",
      users: usersOn(d),
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** 그날이 평소와 다른 방식으로 운영한 시기인지(휴관 중 도시락 배부 등). */
export function isReducedOperation(dateStr: string): boolean {
  return REDUCED_OPERATION.has(dateStr);
}

export function getReducedOperationDays(): string[] {
  return OPERATING_DAYS.filter((d) => REDUCED_OPERATION.has(d));
}

// ── 사람이 몰린 행사일 ──────────────────────────────────────
//
// 식단표에 행사로 적힌 날 중 **실제로 평소보다 많이 오신 날**만 가려냅니다. 우리 자료로
// 확인한 결과는 이렇습니다(그 달 평균 대비):
//
//   04-27 무료 특식 데이  701명  +117%   ← 몰림
//   07-08 무료급식 행사   828명   +92%   ← 몰림
//   07-15 초복           752명   +75%   ← 몰림
//   05-08 어버이날       427명   +19%   ← 몰림
//   08-14 말복           385명    -6%   ← 안 몰림
//
// 말복처럼 이름만 행사이고 사람은 안 몰린 날이 있어서, 라벨만 보고 판정하면 안 됩니다.
export let CROWD_DAYS = new Set<string>();

// 그 달 평균의 몇 배부터 "몰렸다"고 볼지. 1.10이면 10% 이상 많이 오신 날입니다.
export const CROWD_LIFT = 1.1;

function recomputeCrowdDays() {
  const active = getActiveResidents();
  if (!active.length || OPERATING_DAYS.length === 0) {
    CROWD_DAYS = new Set();
    return;
  }
  const count = new Map<string, number>();
  for (const d of OPERATING_DAYS) {
    let n = 0;
    for (const r of active) if (r.attendance[d]) n++;
    count.set(d, n);
  }
  // 달마다 이용자 수 자체가 달라서(3월 260명 → 7월 431명) 전체 평균과 비교하면 여름이
  // 전부 "몰린 날"이 됩니다. 그 달 안에서 비교해야 합니다.
  const byMonth = new Map<string, number[]>();
  for (const [d, n] of count) {
    const m = d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(n);
  }
  const monthAvg = new Map<string, number>();
  for (const [m, list] of byMonth) {
    monthAvg.set(m, list.reduce((a, b) => a + b, 0) / list.length);
  }
  const next = new Set<string>();
  for (const [d, n] of count) {
    if (!getMenuEvent(d)) continue;
    const avg = monthAvg.get(d.slice(0, 7)) ?? 0;
    if (avg > 0 && n / avg >= CROWD_LIFT) next.add(d);
  }
  CROWD_DAYS = next;
}

export function isCrowdDay(dateStr: string): boolean {
  return CROWD_DAYS.has(dateStr);
}

/**
 * 행사 때만 오시는 분인지.
 *
 * 무료 특식 데이·무료급식 행사·초복에는 평소의 두 배가 오시는데, 그날 처음 오신 분 중
 * 상당수가 그 뒤로 다시 오지 않으십니다(초복 68명 중 53명, 78%). 오신 날이 전부 행사일인
 * 분이 281명 — 명부의 10%입니다.
 *
 * 이분들은 경로식당을 이용하시는 분이 아니라 행사에 오신 손님에 가깝습니다. 출결로 위기를
 * 판단할 수 있는 대상이 아닙니다(평소 출석률이 1~3%라 이미 판단 보류로 걸러집니다).
 *
 * 그래도 자료에서 빼지는 않습니다. 지운 자료는 되살릴 수 없고, 이분들 중 누군가는 나중에
 * 정말 다니기 시작하실 수도 있습니다. 명부에서 구분해 보여주고 걸러 볼 수 있게만 합니다.
 */
export function isEventOnlyVisitor(resident: Resident): boolean {
  const days = Object.keys(resident.attendance).filter((d) => resident.attendance[d]);
  if (days.length === 0) return false;
  return days.every((d) => CROWD_DAYS.has(d));
}

export function isOperatingDay(dateStr: string): boolean {
  return OPERATING_DAY_SET.has(dateStr);
}

/**
 * 그 어르신에게 "출석 기회"였던 날들.
 *
 * 처음 오신 날 이전은 세지 않습니다. 그때는 아직 이 기관을 이용하지 않으셨을 수 있는데,
 * 결석으로 세면 없는 결석을 만들어내는 것입니다. 외부변수로 설명되는 날도 뺍니다.
 */
function opportunityDays(resident: Resident, fromStr: string, toStr: string): string[] {
  const since = resident.registeredAt;
  const out: string[] = [];
  for (const d of OPERATING_DAYS) {
    if (d < fromStr || d > toStr) continue;
    if (d < since) continue;
    if (EXTERNALLY_EXPLAINED_DATES.has(d)) continue;
    // 운영 방식이 달랐던 시기는 비교 대상이 아닙니다(위 setOperatingDays 설명 참고).
    if (REDUCED_OPERATION.has(d)) continue;
    out.push(d);
  }
  return out;
}

// 공휴일 ∪ 기관 전체 결석 급증일 (주말 제외). 개인별 위험도 계산에서 공통으로 제외되는 날짜 집합입니다.
// residents가 Supabase에서 비동기로 채워지므로, 데이터가 바뀔 때마다 recomputeExternalFactors()로
// 다시 계산합니다(초기값은 최소한 공휴일만이라도 반영되도록 홀리데이 목록으로 시작).
export let EXTERNALLY_EXPLAINED_DATES = new Set<string>(HOLIDAY_LABELS.keys());

// 그중 "기관 전체가 유독 안 나온 날"만 따로. 화면에서 이름을 정확히 붙이는 데 씁니다 —
// 참고 요인(장날·명절 전후 등)으로 뺀 날까지 결석 급증이라고 하면 사실과 다릅니다.
export let ANOMALY_DATES = new Set<string>();

function recomputeExternalFactors() {
  // 참고 변수(명절 전후·기초연금 지급일)는 공휴일 목록에서 파생됩니다. 어드민에서 공휴일을
  // 추가·삭제하면 명절 구간과 지급일 앞당김 판정이 함께 달라지므로 같이 다시 계산합니다.
  recomputeFestivalAdjacency(HOLIDAY_LABELS);
  recomputePensionWindow(DATA_START_STR, DATA_END_STR, HOLIDAY_LABELS);
  // 몰린 날 판정은 출결에서 나오므로, 제외 날짜를 계산하기 전에 먼저 구합니다.
  recomputeCrowdDays();
  EXTERNALLY_EXPLAINED_DATES = computeExternallyExplainedDates();
}

// 모듈이 처음 불릴 때 한 번 계산해둡니다. Supabase에서 공휴일을 받아오기 전에도 화면이
// 기본값 기준으로는 맞게 그려져야 합니다.
recomputeExternalFactors();

export function isExternallyExplainedDate(dateStr: string): boolean {
  return EXTERNALLY_EXPLAINED_DATES.has(dateStr);
}

// ── Supabase 데이터 로더 ────────────────────────────────────────

type ResidentRow = {
  id: string;
  name: string;
  age_group: string;
  /**
   * 어르신별 담당 직원. 더 이상 쓰지 않습니다 — 사례관리 담당이 따로 정해져 있지 않고,
   * 화면마다 "담당 미지정"만 붙어 자리만 차지했습니다. 표에는 칸이 남아 있고(값을 비워
   * 넣습니다) 화면과 계산에서는 전부 뺐습니다.
   */
  caseworker: string;
  phone: string;
  registered_at: string;
  notes: string;
  status: ResidentStatus;
  photo_url: string | null;
  meal_tier: string | null;
  ai_summary: string | null;
  // migration_017 이후 존재. 없으면 날짜를 안 보여줄 뿐 화면은 그대로 뜹니다.
  ai_summary_at?: string | null;
  ai_needs_update?: boolean | null;
  // migration_022 이후 존재. 없으면 기본값으로 취급합니다(마이그레이션 전에도 화면이 떠야 함).
  watch_status?: WatchStatus | null;
  resume_expected?: string | null;
  downgrade_count?: number | null;
};

type AttendanceRow = { resident_id: string; date: string; present: boolean };

type StaffRow = { name: string };
type HolidayRow = { date: string; label: string };

// ── 대응 이력 ─────────────────────────────────────────────────
// AI가 위기·주의로 올린 어르신을 담당자가 확인하고, 확인 결과 실제로 개입이 필요했는지를
// 남기는 기록입니다. 여기 쌓인 데이터로 "AI 판단 도움 필요 비율"을 실측합니다.

/**
 * 연락 결과.
 *
 *   needed      개입이 필요했다
 *   not_needed  확인해보니 괜찮으셨다 — 정한 기한까지 목록에서 내려둡니다
 *   no_answer   **전화를 안 받으셨다** — 짧게 내려두었다가 곧 다시 올라옵니다
 *
 * no_answer를 따로 둔 이유: 이걸 not_needed로 찍으면 연락이 닿지 않는 분이 안심 처리되어
 * 목록에서 사라집니다. 가장 먼저 다시 봐야 할 분을 가장 먼저 지우는 셈입니다. 도움 필요 비율
 * 계산에서도 "확인을 마친 건"으로 세면 안 됩니다 — 아직 확인하지 못한 것이니까요.
 */
export type FollowupOutcome = "needed" | "not_needed" | "no_answer";

/** 부재중일 때 기본으로 내려두는 기간(일). 2~3일 뒤 자동으로 다시 올라옵니다. */
export const NO_ANSWER_SNOOZE_DAYS = 3;

export interface Followup {
  id: string;
  residentId: string;
  checkedAt: string;
  staff: string;
  riskLevel: RiskLevel;
  outcome: FollowupOutcome;
  note: string;
  /** 지금은 괜찮으심 + "다음 확인 시점" 처리 시, 이 날짜까지 위기 목록에서 빠집니다(YYYY-MM-DD). */
  snoozeUntil: string | null;
  /** 확인 결과 분류 (8-1). 없으면 예전 기록이거나 분류를 건너뛴 것입니다. */
  resultKind: ResultKind | null;
  /** "추석 이후 나오신대요" — 이 날이 지나도 안 나오시면 자동으로 다시 올라옵니다(9-4). */
  resumeExpected: string | null;
  /**
   * 담당자가 **실제로 이 기록을 입력한 일시**(ISO). checkedAt 과 다릅니다.
   *
   * checkedAt 은 **자료 기준일**입니다 — 판정이 어느 날짜를 기준으로 서 있는지. 엔컴 자료가
   * 하루 늦게 들어오므로 9월 16일에 기록해도 기준일은 9월 15일입니다. 그런데 화면이 그
   * 날짜만 「확인 기록 · 2026-09-15」로 보여주니, 오늘 적은 기록이 어제 것으로 보였습니다.
   *
   * 두 날짜는 서로 다른 것을 뜻하므로 각각 저장하고 각각 보여줍니다.
   */
  recordedAt: string | null;
  /**
   * 연락드렸을 때 **어르신 쪽 반응**.
   *
   * 「도움 필요 비율」은 담당자가 판단한 값입니다. 어르신께 이 전화가 어떻게 닿았는지는
   * 아무 데도 안 남았습니다. 그런데 현장에서 가장 자주 나오는 이야기가 그것입니다 —
   * "걱정해 줘서 고맙다고 하시더라", "왜 자꾸 전화하냐고 하시더라".
   *
   * 한 해 치를 모으면 출석률로는 절대 안 나오는 이야기를 숫자로 말할 수 있습니다.
   * 안 고르면 null 이고, null 이 기본입니다 — 억지로 고르게 하면 아무 뜻이 없어집니다.
   */
  reaction: FollowupReaction;
  /**
   * 반응을 한 줄로. 단추(reaction)가 「어느 쪽인가」라면 이 칸은 「왜 그러셨나」입니다.
   *
   * 두 단추만으로는 "불편해하심"이 **전화가 귀찮으셨던 것인지, 감시받는 기분이셨던
   * 것인지** 구분되지 않습니다. 앞은 시간대를 바꾸면 되고 뒤는 우리가 말을 거는 방식을
   * 바꿔야 하는, 완전히 다른 이야기입니다. 비어 있어도 됩니다(migration_027).
   */
  reactionNote: string;
}

/** 연락에 대한 어르신 반응. 안 고르면 null. */
export type FollowupReaction = "positive" | "negative" | null;

export const REACTION_META: Record<
  "positive" | "negative",
  { label: string; hint: string; emoji: string }
> = {
  positive: {
    label: "반가워하심",
    hint: "고맙다고 하시거나, 안부를 되물으시거나, 반가워하셨습니다",
    emoji: "😊",
  },
  negative: {
    label: "불편해하심",
    hint: "귀찮아하시거나, 전화를 꺼리시거나, 불편해하셨습니다",
    emoji: "😕",
  },
};

type FollowupRow = {
  id: string;
  resident_id: string;
  checked_at: string;
  staff: string;
  risk_level: RiskLevel;
  outcome: FollowupOutcome;
  note: string;
  snooze_until?: string | null; // migration_018 이후 존재. 없으면 null로 취급.
  result_kind?: ResultKind | null; // migration_022 이후 존재.
  resume_expected?: string | null;
  created_at?: string | null; // 실제 입력 일시. 표에 처음부터 있던 칸입니다.
  reaction?: FollowupReaction; // migration_026 이후 존재.
  reaction_note?: string | null; // migration_027 이후 존재.
};

export let FOLLOWUPS: Followup[] = [];

let loadPromise: Promise<void> | null = null;

// 앱 시작 시 한 번만 Supabase에서 전체 데이터를 불러옵니다. 이미 불러왔거나 불러오는 중이면
// 그 Promise를 그대로 재사용합니다(중복 요청 방지).
// 로그아웃할 때 호출합니다. 조회조차 로그인이 필요하므로, 로그아웃 상태로 한 번 불러오면
// "빈 데이터"가 캐시에 남습니다. 그대로 두면 다시 로그인해도 화면이 계속 비어 있습니다.
export function resetDataLoad(): void {
  loadPromise = null;
  residents = [];
  FOLLOWUPS = [];
  notify();
}

/**
 * 자료를 새로 넣은 뒤 다시 받아옵니다.
 *
 * resetDataLoad()와 다릅니다 — 그쪽은 로그아웃용이라 목록을 비워버려서, 새 자료가 도착할
 * 때까지 화면이 "어르신 0명"으로 보입니다. 여기서는 들고 있던 자료를 그대로 두고 받아오기만
 * 다시 걸어, 도착하는 순간 조용히 바뀌게 합니다.
 *
 * 이게 없으면 자료를 넣은 사람이 대시보드로 넘어갔을 때 **넣기 전 숫자**를 보게 됩니다.
 * 넣었는지 안 넣었는지 화면만 봐서는 알 수 없으니, 직접 새로고침을 누르기 전까지 옛 명단으로
 * 일하게 됩니다.
 */
export async function reloadData(): Promise<void> {
  loadPromise = null;
  await ensureDataLoaded();
  notify();
}

export function ensureDataLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      // 외부변수 스위치도 화면이 그려지기 전에 도착해야 합니다 — 늦게 오면 껐던 변수가 한 번
      // 깜빡였다 사라져, 담당자가 자기 설정이 반영됐는지 알 수 없게 됩니다.
      //
      // 두 개를 나란히 보냅니다. 줄 세우면 왕복 한 번이 그대로 더해지고, 서로 필요한 값이
      // 없어서 기다릴 이유도 없습니다.
      await Promise.all([
        loadFactorSettings(),
        loadMenus(),
        loadDataIssueChecks(),
        loadFromSupabase(),
      ]);

      // 날씨는 **자료 범위가 정해진 뒤에** 받아옵니다.
      //
      // 예전에는 이 블록 바깥에서 곧바로 불렀는데, 그 시점의 DATA_START_STR·DATA_END_STR는
      // 아직 씨앗값(2025-01-02 ~ 2026-08-28)이었습니다. loadFromSupabase가 끝나야
      // applyDataRange가 실제 범위로 갱신하기 때문입니다. 게다가 loadWeather는 한 번
      // 받아오면 다시 받지 않아서, 9월 자료를 넣어도 9월 날씨는 영영 비어 있었습니다.
      //
      // 화면을 붙잡지는 않습니다 — 따로 받아오고, 도착하면 그때 다시 계산해 그립니다.
      void loadWeather(DATA_START_STR, DATA_END_STR).then(() => {
        recomputeExternalFactors();
        notify();
      });
    })();
  }
  return loadPromise;
}

// PostgREST는 한 번에 최대 1000행만 돌려줍니다. 출석은 이미 7천 행이 넘고 실제 자료를 넣으면
// 8만 행이 되므로, 나눠서 여러 번 받아야 합니다.
//
// 예전에는 1000행씩 "받고 → 다음 요청" 을 줄 세워 반복했습니다. 8만 행이면 요청 83번을 하나씩
// 기다리게 되어 십수 초가 걸립니다. 그래서 전체 개수를 먼저 물어본 뒤 페이지들을 한꺼번에
// 요청합니다. 한 번에 너무 많이 던지면 브라우저와 서버 양쪽에서 막히므로 몇 개씩 묶어 보냅니다.
//
// 정렬을 함께 넣은 이유(속도와 별개로 중요합니다): 순서를 정하지 않고 range로 잘라 받으면
// 데이터베이스가 매번 다른 순서로 돌려줄 수 있어, 어떤 행은 두 번 들어오고 어떤 행은 아예
// 빠집니다. 출석 한 건이 빠지면 그날 안 나오신 것으로 잡혀 멀쩡한 어르신이 위험군이 됩니다.
const PAGE_SIZE = 1000;
const MAX_PARALLEL_PAGES = 6;

async function fetchAllRows<T>(
  table: string,
  columns: string,
  orderBy: string[],
): Promise<{ data: T[]; error: Error | null }> {
  const applyOrder = <Q extends { order: (c: string, o: { ascending: boolean }) => Q }>(q: Q): Q =>
    orderBy.reduce((acc, col) => acc.order(col, { ascending: true }), q);

  // head: true — 개수만 받고 자료는 받지 않습니다.
  const { count, error: countError } = await supabase
    .from(table)
    .select(columns, { count: "exact", head: true });
  if (countError) return { data: [], error: countError };

  const total = count ?? 0;
  if (total === 0) return { data: [], error: null };

  const pageCount = Math.ceil(total / PAGE_SIZE);
  const pages: T[][] = new Array(pageCount);

  for (let start = 0; start < pageCount; start += MAX_PARALLEL_PAGES) {
    const batch = [];
    for (let i = start; i < Math.min(start + MAX_PARALLEL_PAGES, pageCount); i++) {
      const from = i * PAGE_SIZE;
      batch.push(
        applyOrder(supabase.from(table).select(columns))
          .range(from, from + PAGE_SIZE - 1)
          .then(({ data, error }) => {
            if (error) throw error;
            pages[i] = (data ?? []) as T[];
          }),
      );
    }
    try {
      await Promise.all(batch);
    } catch (err) {
      return { data: [], error: err as Error };
    }
  }

  return { data: pages.flat(), error: null };
}

async function loadFromSupabase(): Promise<void> {
  const [
    { data: residentRows, error: residentsError },
    { data: attendanceRows, error: attendanceError },
    { data: staffRows, error: staffError },
    { data: holidayRows, error: holidaysError },
    { data: followupRows, error: followupsError },
  ] = await Promise.all([
    fetchAllRows<ResidentRow>("residents", "*", ["id"]),
    fetchAllRows<AttendanceRow>("attendance", "resident_id,date,present", ["resident_id", "date"]),
    fetchAllRows<StaffRow>("staff", "*", ["name"]),
    fetchAllRows<HolidayRow>("holidays", "*", ["date"]),
    fetchAllRows<FollowupRow>("followups", "*", ["id"]),
  ]);

  // followups는 나중에 추가된 표라, 마이그레이션을 아직 실행하지 않은 환경에서도 앱 전체가
  // 죽지 않도록 이 표의 오류만 따로 다뤄 빈 목록으로 넘어갑니다.
  if (followupsError) {
    console.warn(
      "대응 이력(followups) 표를 읽지 못했습니다. supabase/migration_005_followups.sql 을 실행해주세요.",
      followupsError,
    );
    FOLLOWUPS = [];
  } else {
    FOLLOWUPS = followupRows.map((f) => ({
      id: f.id,
      residentId: f.resident_id,
      checkedAt: f.checked_at,
      staff: f.staff,
      riskLevel: f.risk_level,
      outcome: f.outcome,
      note: f.note ?? "",
      snoozeUntil: f.snooze_until ?? null,
      // 표에 없는 갈래는 여기서 버립니다.
      //
      // migration_028 이 DB 제약에 「판정중단」을 넣었는데 그 갈래를 코드에서 뺐습니다.
      // DB 에 그 값이 한 줄이라도 남아 있으면 RESULT_KIND_META[...] 가 undefined 가 되고,
      // .label 을 읽는 화면이 통째로 죽습니다 — 대시보드가 죽으면 396명 전원이
      // 모든 목록에서 사라집니다. 화면마다 ?. 를 붙이는 것보다 들어오는 문을 막는 편이
      // 확실합니다. 갈래만 비우고 기록 자체는 그대로 씁니다(메모·날짜는 살아 있습니다).
      resultKind: f.result_kind && f.result_kind in RESULT_KIND_META ? f.result_kind : null,
      resumeExpected: f.resume_expected ?? null,
      reaction: f.reaction ?? null,
      reactionNote: f.reaction_note ?? "",
      recordedAt: f.created_at ?? null,
    }));
  }

  const firstError = residentsError ?? attendanceError ?? staffError ?? holidaysError;
  if (firstError) {
    console.error("Supabase 데이터 로드 실패", firstError);
    throw firstError;
  }

  if (staffRows.length > 0) STAFF_MEMBERS = staffRows.map((s) => s.name).sort();
  if (holidayRows.length > 0) {
    HOLIDAY_LABELS = new Map(holidayRows.map((h) => [h.date, h.label]));
  }

  const attendanceByResident = new Map<string, Record<string, boolean>>();
  for (const row of attendanceRows) {
    const rec = attendanceByResident.get(row.resident_id) ?? {};
    rec[row.date] = row.present;
    attendanceByResident.set(row.resident_id, rec);
  }

  residents = residentRows.map((r) => {
    return {
      id: r.id,
      name: r.name,
      ageGroup: r.age_group,
      phone: r.phone,
      registeredAt: r.registered_at,
      watchStatus: r.watch_status ?? "감시중",
      resumeExpected: r.resume_expected ?? null,
      downgradeCount: r.downgrade_count ?? 0,
      notes: r.notes,
      status: r.status,
      photoUrl: r.photo_url ?? undefined,
      mealTier: r.meal_tier === "감면" || r.meal_tier === "무료급식" ? r.meal_tier : "일반",
      aiSummary: r.ai_summary ?? undefined,
      aiSummaryAt: r.ai_summary_at ? String(r.ai_summary_at).slice(0, 10) : undefined,
      aiNeedsUpdate: r.ai_needs_update ?? false,
      attendance: attendanceByResident.get(r.id) ?? {},
    };
  });

  // 운영일은 출결 기록에서 도출합니다. 어르신 목록을 채운 **뒤**, 그리고 외부변수를
  // 다시 계산하기 **전**에 해야 합니다 — 결석 급증일 판정이 운영일 목록을 보기 때문입니다.
  // 자료의 실제 범위를 먼저 반영합니다(새로 넣은 자료가 잘려나가지 않도록).
  applyDataRange(attendanceRows.map((a) => a.date));
  setOperatingDays(attendanceRows);

  recomputeExternalFactors();
  notify();

  // 사진 주소는 화면을 붙잡아두지 않습니다 — 사진이 조금 늦게 뜨는 것은 괜찮지만,
  // 사진 때문에 어르신 목록이 늦게 뜨면 안 됩니다.
  void loadResidentPhotoUrls();
}

// ── 실시간 반응성(pub/sub) ─────────────────────────────────────

let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version += 1;
  listeners.forEach((l) => l());
}

function subscribeDataStore(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getDataVersion() {
  return version;
}

export function useDataVersion(): number {
  return useSyncExternalStore(subscribeDataStore, getDataVersion, getDataVersion);
}

/**
 * 자료 자체는 그대로인데 해석 기준이 바뀌었을 때 화면을 다시 그립니다.
 * (외부변수 스위치를 켜고 끌 때 씁니다 — 값은 external-factors.ts 안에 있어서
 *  리액트가 스스로 알아채지 못합니다.)
 */
// AI 판단 결과를 화면 상태에 즉시 반영합니다(Edge Function이 DB에는 이미 저장했습니다).
export function setResidentAiSummary(id: string, summary: string): void {
  const r = getResidentById(id);
  if (!r) return;
  r.aiSummary = summary;
  r.aiSummaryAt = toDateStr(new Date());
  r.aiNeedsUpdate = false;
  notify();
}

export function notifyDataChanged(): void {
  // 외부변수 스위치를 켜고 끄면 "계산에서 빼는 날"이 달라집니다. 다시 계산하지 않으면
  // 스위치를 만져도 위기·주의 인원이 그대로여서, 스위치가 아무 일도 안 한 것처럼 보입니다.
  recomputeExternalFactors();
  notify();
}

/**
 * "오늘 뵀습니다"를 손으로 남깁니다. **오신 것만** 기록합니다.
 *
 * 안 오신 것은 기록하지 않습니다. 이 앱에서 결석은 **기록이 없는 것**이기 때문입니다.
 * 손으로 결석을 적으면 그 날짜가 운영일 목록에 들어가고, 그러면 **그날 기록이 없는 다른
 * 400여 분이 전부 결석 처리**됩니다. 한 사람을 챙기려다 전원을 위기로 만드는 셈입니다.
 *
 * 그래서 화면에도 "오셨습니다" 버튼만 둡니다.
 */
export async function markVisited(
  residentId: string,
  dateStr: string,
): Promise<{ ok: boolean; error: string | null }> {
  const resident = getResidentById(residentId);
  if (!resident) return { ok: false, error: "어르신을 찾지 못했습니다" };
  resident.attendance[dateStr] = true; // 낙관적으로 먼저 반영해 화면이 바로 갱신되게 함
  notify();
  const { error } = await supabase
    .from("attendance")
    .upsert(
      { resident_id: residentId, date: dateStr, present: true },
      { onConflict: "resident_id,date" },
    );
  if (error) {
    delete resident.attendance[dateStr]; // 저장 실패 시 되돌림
    notify();
    console.error("방문 기록 저장 실패", error);
    return { ok: false, error: error.message };
  }
  return { ok: true, error: null };
}

export function bulkRecordAttendance(dateStr: string, present: boolean) {
  const active = getActiveResidents();
  for (const r of active) r.attendance[dateStr] = present;
  recomputeExternalFactors();
  notify();
  const rows: AttendanceRow[] = active.map((r) => ({
    resident_id: r.id,
    date: dateStr,
    present,
  }));
  supabase
    .from("attendance")
    .upsert(rows, { onConflict: "resident_id,date" })
    .then(({ error }) => {
      if (error) {
        console.error("일괄 출석 저장 실패", error);
        toast.error("일괄 출석 저장에 실패했습니다. 네트워크를 확인해주세요.");
      }
    });
}

// 한 어르신의 가장 최근 대응 이력. 대시보드에서 "이미 확인한 분"을 구분하는 데 씁니다.
/**
 * 이 확인 기록이 「종결」인가 — 급식으로 더 볼 수 없게 된 분.
 *
 * 종결이 되는 길이 **두 갈래**인데 화면마다 한 갈래만 보고 있었습니다.
 *   · 「사례 관리 종료」 단추 → 갈래(resultKind)는 비어 있고 메모에 "[종결] " 접두사
 *   · AI·규칙 분류        → 메모는 원문 그대로, 갈래에 "사망"·"이사전출" 등
 * 접두사만 보던 화면에서는 **돌아가신 분이 「잠시 제외 · 여행·가족방문」 상자에**
 * "~12-31까지"로 떴습니다. 두 갈래를 여기서 한 번에 봅니다.
 */
export function isClosedFollowup(f: Followup): boolean {
  if (f.note.startsWith("[종결]")) return true;
  return !!f.resultKind && RESULT_KIND_META[f.resultKind]?.status === "종료";
}

/**
 * 이 확인 기록이 「보류」인가 — 사정을 알아서 판정을 멈춘 분(입원·일자리 참여 등).
 *
 * 보류는 종결이 아닙니다. 돌아오실 분이고, 그래서 **눈에 보이는 자리에 있어야** 합니다.
 * 지금 판정 엔진은 보류를 「자료 부족」으로 뭉개 어느 목록에도 안 남깁니다. 화면이
 * 기록에서 직접 세어 따로 보여줍니다.
 */
export function isPausedFollowup(f: Followup): boolean {
  if (isClosedFollowup(f)) return false;
  return !!f.resultKind && RESULT_KIND_META[f.resultKind]?.status === "보류";
}

/**
 * 가장 최근 확인 기록.
 *
 * ★ `asOfStr` 을 주면 **그 시점까지의 기록만** 봅니다. 안 주면 전부 봅니다.
 *
 *   이 함수만 {@link followupCutoff} 를 안 거치고 있었습니다. 그런데 대시보드의 목록
 *   구성이 전부 이 값으로 갈립니다 — 「연락할 분」에 넣을지, 「잠시 제외」로 뺄지.
 *   그래서 7월을 되짚어 보면 **9월에 적은 확인 기록이 7월 화면에 반영**됐습니다 —
 *
 *     7월 15일 화면에서 김○○ 어르신이 안 보임
 *     → 왜? 9월 3일에 「이사전출」로 종결 처리했기 때문
 *     → 7월에 담당자가 왜 이분을 놓쳤는지 되짚을 수가 없습니다
 *
 *   지난 달을 여는 이유는 대개 "그때 우리가 뭘 봤나"를 확인하기 위해서입니다. 미래의
 *   답을 섞어 보여주면 그 질문에 답할 수 없습니다. 오늘을 볼 때는 cutoff 가 오늘까지를
 *   인정하므로(자료는 어제까지여도) 지금 적은 기록이 바로 반영됩니다.
 */
export function getLatestFollowup(residentId: string, asOfStr?: string): Followup | null {
  const cutoff = asOfStr ? followupCutoff(asOfStr) : null;
  const list = FOLLOWUPS.filter(
    (f) => f.residentId === residentId && (!cutoff || f.checkedAt <= cutoff),
    // 같은 날 두 번 기록했을 때 **누가 이기는지**를 정합니다.
    //
    // 예전에는 날짜만 비교했습니다. 같은 날짜면 비교자가 언제나 -1 을 돌려주는데,
    // 이건 "같다"를 표현할 방법이 없는 잘못된 비교자라 결과가 정렬 구현에 달립니다.
    // 실제로 이런 일이 났습니다 — 오전에 부재중, 오후에 통화 성공을 적으면 **그 자리에서는**
    // 오전 기록이 최신으로 뽑혀, 방금 통화한 분이 「연락할 분」에 그대로 남았습니다.
    // (새로고침하면 배열 순서가 바뀌어 증상이 사라지니 더 잡기 어려웠습니다.)
    //
    // getMemberState·getActiveSnooze·getFollowupsForResident 와 대시보드의 두 곳은
    // 전부 id 로 뒤를 고릅니다. 이 함수만 빠져 있어서, **판단에 쓰는 기록과 화면에
    // 보이는 기록이 서로 달랐습니다.** 같은 규칙으로 맞춥니다.
  ).sort((a, b) =>
    a.checkedAt !== b.checkedAt ? (a.checkedAt < b.checkedAt ? 1 : -1) : b.id.localeCompare(a.id),
  );
  return list[0] ?? null;
}

/** 기한을 안 정하고 「도움이 더 필요」로 적었을 때 다시 볼 때까지의 날 수. */
export const DEFAULT_RECHECK_NEEDED = 7;
/** 기한을 안 정하고 「지금은 괜찮으심」으로 적었을 때 다시 볼 때까지의 날 수. */
export const DEFAULT_RECHECK_NOT_NEEDED = 14;

/**
 * 이 확인 기록이 어르신을 「연락할 분」에서 **언제까지** 빼 주는가.
 *
 * 예전에는 기한(snoozeUntil)이 적힌 「지금은 괜찮으심」 기록만 빼 줬습니다. 그래서
 * 이런 일이 났습니다 —
 *
 *   「도움이 더 필요」로 적음   → 기한을 안 겁니다(도와드리는 중이니까)
 *                              → 빼 줄 근거가 없어 **영원히** 목록에 남음
 *   「현재 지원 없음 · 기한없음」 → 마찬가지로 영원히 남음
 *
 * 담당자가 통화하고 기록까지 남겼는데 그분이 「지금 먼저 연락할 분」 맨 위에 그대로
 * 있으면, 기록이 안 먹혔다고 읽습니다. 실제로 그렇게 읽혔습니다.
 *
 * 이제 **연락이 닿은 기록은 모두 다시 볼 날을 갖습니다.** 담당자가 정했으면 그 날,
 * 안 정했으면 기본값입니다. 그 날이 지나면 자동으로 돌아옵니다 — 사라지지 않습니다.
 *
 * 부재중(no_answer)만 예외입니다. 아직 **못 만난** 것이라 확인이 끝나지 않았고,
 * 사양이 "연락이 안 되는 것 자체가 위기 신호"라고 못박아 두었습니다.
 */
export function recheckDueDate(f: Followup): string | null {
  // 갈래도 함께 봅니다. outcome 만 보면, 「확인 불가」로 적은 기록을 나중에 이력에서
  // 「지금은 괜찮으심 + 기한」으로 고쳤을 때 **연락이 안 되는 분이 목록에서 빠집니다.**
  // 사양이 못박은 「확인 불가는 해제 사유가 아님」이 그 경로로 뚫렸습니다.
  if (f.outcome === "no_answer" || f.resultKind === "확인불가") return null;
  if (f.snoozeUntil) return f.snoozeUntil;
  const days = f.outcome === "needed" ? DEFAULT_RECHECK_NEEDED : DEFAULT_RECHECK_NOT_NEEDED;
  return toDateStr(addDays(parseDateStr(f.checkedAt), days));
}

/**
 * 이 확인 기록이 **오늘도 그분을 「연락할 분」에서 빼 주는가.**
 *
 * 화면 두 곳이 같은 질문을 합니다 — 「연락할 분」은 "오늘 걸어야 하나"를 묻고,
 * 「사유를 확인한 분」은 "당분간 안 봐도 되나"를 묻습니다. 같은 사람을 두고 두
 * 곳이 각자 계산하면 어느 날 **양쪽에 다 뜨거나 양쪽에서 다 빠집니다.** 실제로
 * 그런 일이 있었고, 그래서 판단을 한 군데로 모읍니다.
 *
 * 날짜의 뜻: `recheckDueDate` 가 돌려주는 날은 **쉬는 마지막 날**입니다.
 * 화면이 「~09-25까지」라고 적는 그 날이고, 복귀는 그 다음 날입니다.
 * (기한을 직접 거신 경우 snoozeUntil 이 그대로 그 날이 되므로 뜻이 같습니다.)
 *
 * 부재중·확인불가는 recheckDueDate 가 null 이라 여기서 언제나 false 입니다 —
 * 연락이 안 되는 것은 해제 사유가 아니라 그 자체로 신호이기 때문입니다.
 */
export function isRestingOn(f: Followup, asOfStr: string): boolean {
  if (isClosedFollowup(f)) return true; // 종결은 영구히
  const due = recheckDueDate(f);
  return !!due && due >= asOfStr;
}

// AI 판단 도움 필요 비율 — 확인을 마친 건 중 실제로 개입이 필요했던 비율.
// 본선에서 "이 도구가 현장을 바꿨는가"에 답할 때 쓰는 수치입니다.
export function getFollowupStats(
  year: number,
  month: number,
): {
  checked: number;
  needed: number;
  notNeeded: number;
  noAnswer: number;
  precision: number | null;
} {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  return tallyFollowups(FOLLOWUPS.filter((f) => f.checkedAt.startsWith(prefix)));
}

/**
 * 어르신 반응 집계 — 연 단위가 기본입니다.
 *
 * 왜 연 단위인가: 한 달 치는 스무 건 남짓이라 한두 분의 기분이 비율을 흔듭니다.
 * 이 숫자로 말하려는 것은 "이번 달 분위기"가 아니라 **"이 방식이 어르신들께 어떻게
 * 받아들여지는가"** 이고, 그건 계절을 한 바퀴 돌려야 보입니다.
 *
 * 안 고른 기록(null)은 분모에서 뺍니다. 억지로 반반 나누면 없는 이야기를 만듭니다.
 */
/**
 * 어르신 반응 집계.
 *
 * ★ 분모에서 **부재중을 뺍니다.** 「반응을 적은 비율」의 분모에 어르신을 만나지도
 *   못한 건이 들어가 있었습니다 — 바로 옆 「도움 필요 비율」은 같은 부재중을 분모에서
 *   빼고 그 사실을 화면에 두 번 적어 두었는데, 여기만 반대로 세고 있었습니다.
 */
/**
 * 그 달에 이 등급으로 **감지된 어르신 전원**의 회원번호.
 *
 * ★ 같은 「9월 긴급 인원」이 화면마다 달랐습니다 — 대시보드 11명 · 통계 막대 4명 ·
 *   위험군 리포트 4명. 확인을 마쳐 판정이 멈춘 분(보류·종결)을 대시보드만 되살려
 *   세고 나머지는 안 셌기 때문입니다. **위험군 리포트는 인쇄해서 내는 문서**라,
 *   화면과 인쇄물이 다른 수를 말하면 그 자리에서 드러납니다.
 *
 * 두 갈래를 합칩니다 —
 *   ① 그 달 말 기준으로 지금도 그 등급인 분 (가려지기 전 등급으로 봅니다)
 *   ② 그 달에 그 등급으로 확인 기록이 남은 분 (그 뒤 보류·종결돼 판정에서 빠진 분)
 *
 * `alsoAfter` 는 「이 달 이후에 적은 기록도 이 달 몫으로 셀지」입니다. 자료가
 * 9/17 까지인데 10월 1일에 남긴 기록은 달 접두어로 안 잡혀, 확인할수록 그 달
 * 인원이 줄어듭니다. 가장 최근 달을 볼 때만 켭니다.
 */
export function getMonthDetectedIds(
  year: number,
  month: number,
  level: "crisis" | "caution",
  alsoAfter?: string,
): Set<string> {
  const ids = new Set<string>();
  const monthEnd = new Date(year, month, 0);
  // ★ 명부에 있는 분만 셉니다.
  //
  //   아래 확인 기록 루프는 f.residentId 를 아무 검사 없이 넣고 있었습니다. 그래서
  //   퇴소하신 분, 그리고 명부에 아예 없는 회원번호(자료 오류로 들어온 것)까지
  //   막대 높이에 더해졌습니다. 그 숫자로 인력·예산을 말하면 어긋납니다.
  const onRoster = new Set<string>();
  for (const r of getActiveResidents()) {
    onRoster.add(r.id);
    if (getCurrentRisk(r, monthEnd).level === level) ids.add(r.id);
  }
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  for (const f of FOLLOWUPS) {
    if (f.riskLevel !== level) continue;
    if (!onRoster.has(f.residentId)) continue;
    if (f.checkedAt.startsWith(prefix) || (!!alsoAfter && f.checkedAt > alsoAfter))
      ids.add(f.residentId);
  }
  return ids;
}

export function getReactionStats(
  from: string,
  to: string,
): { positive: number; negative: number; answered: number; total: number; ratio: number | null } {
  let positive = 0;
  let negative = 0;
  let total = 0;
  for (const f of FOLLOWUPS) {
    if (f.checkedAt < from || f.checkedAt > to) continue;
    // 부재중은 어르신을 만나지 못한 건입니다. 반응을 적을 수 없는 자리이므로
    // 「반응을 적은 비율」의 분모에 넣으면 담당자가 안 적은 것처럼 보입니다.
    if (f.outcome === "no_answer" || f.resultKind === "확인불가") continue;
    total++;
    if (f.reaction === "positive") positive++;
    else if (f.reaction === "negative") negative++;
  }
  const answered = positive + negative;
  return {
    positive,
    negative,
    answered,
    total,
    ratio: answered >= REACTION_MIN_SAMPLE ? Math.round((positive / answered) * 100) : null,
  };
}

/** 반응 비율을 보여주기 시작하는 최소 표본. 이보다 적으면 숫자가 아니라 우연입니다. */
export const REACTION_MIN_SAMPLE = 10;

/** 도움 필요 비율을 보여주기 시작하는 최소 표본. 이보다 적으면 숫자가 아니라 우연입니다. */
export const PRECISION_MIN_SAMPLE = 10;

/**
 * 누적 도움 필요 비율 (전체 기간).
 *
 * 왜 달이 아니라 누적인가 — 도움 필요 비율은 **비율**이라 표본이 적으면 의미가 없습니다.
 * 한 달에 3건 확인해서 1건이 개입 필요였으면 33%인데, 다음 달에 2건 중 1건이면 50%입니다.
 * 이 등락은 도구가 좋아지거나 나빠진 것이 아니라 그냥 표본이 작은 것입니다. 그 숫자로
 * "이 도구가 쓸모 있는가"를 말할 수 없습니다.
 *
 * 반면 **활동량**(몇 건 확인했나)은 달마다 보는 것이 맞습니다 — 그건 업무 리듬이라
 * 이번 달에 줄었는지가 바로 의미를 가집니다. 그래서 둘을 나눠 씁니다.
 */
export function getFollowupStatsAll() {
  return tallyFollowups(FOLLOWUPS);
}

function tallyFollowups(inMonth: Followup[]) {
  const needed = inMonth.filter((f) => f.outcome === "needed").length;
  const noAnswer = inMonth.filter((f) => f.outcome === "no_answer").length;
  const notNeeded = inMonth.length - needed - noAnswer;
  // 부재중은 분모에서 뺍니다. 아직 확인하지 못한 건이라, 이걸 "확인했는데 개입이 필요 없었다"
  // 쪽에 넣으면 도움 필요 비율이 실제보다 낮게 나옵니다 — 도구를 부당하게 깎아내리는 수치가 됩니다.
  const decided = needed + notNeeded;
  return {
    checked: inMonth.length,
    needed,
    notNeeded,
    noAnswer,
    precision: decided === 0 ? null : Math.round((needed / decided) * 100),
  };
}

export async function addFollowup(input: {
  residentId: string;
  checkedAt: string;
  staff: string;
  riskLevel: RiskLevel;
  outcome: FollowupOutcome;
  note: string;
  snoozeUntil?: string | null;
  reaction?: FollowupReaction;
  reactionNote?: string;
  resultKind?: ResultKind | null;
  resumeExpected?: string | null;
}) {
  const followup: Followup = {
    id: `f-${input.residentId}-${Date.now()}`,
    residentId: input.residentId,
    checkedAt: input.checkedAt,
    staff: input.staff,
    riskLevel: input.riskLevel,
    outcome: input.outcome,
    note: input.note,
    snoozeUntil: input.snoozeUntil ?? null,
    reaction: input.reaction ?? null,
    reactionNote: input.reactionNote?.trim() ?? "",
    resultKind: input.resultKind ?? null,
    resumeExpected: input.resumeExpected ?? null,
    recordedAt: new Date().toISOString(),
  };
  FOLLOWUPS = [followup, ...FOLLOWUPS]; // 낙관적으로 먼저 반영해 화면이 바로 갱신되게 함
  notify();
  // snooze_until 은 migration_018 이후에만 있는 컬럼이라, 값이 있을 때만 payload에 넣습니다.
  // 그래야 마이그레이션 전에도 기존 "개입 필요/불필요" 저장이 깨지지 않습니다.
  const payload: Record<string, unknown> = {
    id: followup.id,
    resident_id: followup.residentId,
    checked_at: followup.checkedAt,
    staff: followup.staff,
    risk_level: followup.riskLevel,
    outcome: followup.outcome,
    note: followup.note,
  };
  if (followup.snoozeUntil) payload.snooze_until = followup.snoozeUntil;
  // migration_026 이후에만 있는 칸이라 값이 있을 때만 넣습니다(안 돌린 환경에서도
  // 저장이 깨지지 않게). addFollowup 이 원래 지키던 규칙과 같습니다.
  if (followup.reaction) payload.reaction = followup.reaction;
  // migration_027 이후에만 있는 칸. 위와 같은 규칙으로 값이 있을 때만 넣습니다.
  if (followup.reactionNote) payload.reaction_note = followup.reactionNote;
  // result_kind·resume_expected 도 migration_022 이후에만 있는 칸이라 값이 있을 때만 넣습니다.
  if (followup.resultKind) payload.result_kind = followup.resultKind;
  if (followup.resumeExpected) payload.resume_expected = followup.resumeExpected;
  // 저장 결과를 **돌려줍니다.**
  //
  // 예전에는 불붙여놓고 잊는(fire-and-forget) 방식이라, 부르는 쪽이 성공 여부를 모른 채
  // "기록했습니다" 토스트를 띄웠습니다. 실제로 그런 일이 있었습니다 — 제약 조건에 걸려
  // 저장이 400으로 거부됐는데 화면에는 빨간 실패 토스트와 초록 성공 토스트가 **동시에** 떴고,
  // 담당자는 기록된 줄 알았습니다. 확인 기록이 시스템의 되먹임 전부인데, 그게 조용히
  // 사라지면 이 도구는 아무것도 배우지 못합니다.
  const { error } = await supabase.from("followups").insert(payload);
  if (error) {
    console.error("대응 이력 저장 실패", error);
    FOLLOWUPS = FOLLOWUPS.filter((f) => f.id !== followup.id); // 저장 실패 시 되돌림
    notify();
    // 무엇 때문에 막혔는지 그대로 보여줍니다. "네트워크를 확인하세요"는 원인이 스키마일 때
    // 담당자를 엉뚱한 곳으로 보냅니다.
    return { ok: false as const, error: error.message };
  }
  return { ok: true as const, error: null };
}

// 한 어르신의 개입 이력 전체 — 최근 확인이 맨 위에 옵니다.
// 마지막 결과만 보여주면 판단을 잘못하게 됩니다: 1차 확인에서 "지금은 괜찮으심"였던 어르신이
// 두 달 뒤 다시 위험군에 오르는 일은 흔하고, 그때는 "지난번엔 왜 불필요였는지"를 읽어야
// 이번엔 개입이 필요한지 판단할 수 있습니다. 그래서 이력을 덮어쓰지 않고 쌓아둡니다.
export function getFollowupsForResident(residentId: string): Followup[] {
  return FOLLOWUPS.filter((f) => f.residentId === residentId).sort((a, b) => {
    if (a.checkedAt !== b.checkedAt) return a.checkedAt < b.checkedAt ? 1 : -1;
    return b.id.localeCompare(a.id); // 같은 날 여러 번 확인했으면 나중에 기록한 것이 위로
  });
}

// 확인 결과를 잘못 눌렀거나, 나중에 사정을 더 알게 되어 판단이 바뀌는 경우를 위한 수정입니다.
// 새 이력을 하나 더 쌓는 것(= 2차 확인)과는 다릅니다 — 이쪽은 같은 확인 건을 고치는 것입니다.
/**
 * 확인 기록을 고칩니다.
 *
 * ★ `snoozeUntil` 과 `resultKind` 도 고칠 수 있어야 합니다.
 *
 *   예전에는 `{outcome, note, staff}` 셋만 바꿨습니다. 그런데 어르신을 목록에서 빼는
 *   것은 그 셋이 아니라 **snoozeUntil 과 resultKind** 입니다. 종결 단추는
 *   `snoozeUntil: "2999-12-31"` 을 심습니다 — 976년치 안심입니다.
 *
 *   그래서 화면이 「기록을 고치면 목록으로 돌아옵니다」라고 안내하는데도, 실제로는
 *   글자만 바뀌고 어르신은 계속 사라진 채였습니다. **잘못 누른 종결을 되돌릴 방법이
 *   앱 안에 아예 없었습니다.** 사람이 실수하는 단추일수록 되돌리는 길이 있어야 합니다.
 */
/**
 * 확인 기록을 고칩니다. **성공 여부를 돌려줍니다.**
 *
 * 예전에는 돌려주지 않고 `.then()` 안에서만 실패를 처리했습니다. 그래서 부르는 쪽이
 * 서버 응답을 기다리지 않고 곧바로 초록색 「수정했습니다」를 띄웠습니다. 저장이 거부되면
 * **나중에** 빨간 토스트가 뜨고 화면이 되돌아가는데, 담당자는 이미 초록 토스트를 봤으니
 * 고쳐진 줄 압니다. addFollowup 이 같은 사고로 한 번 고쳐진 자리인데(그 주석 참고)
 * 수정·되돌리기·삭제 경로에는 그대로 남아 있었습니다.
 */
export async function updateFollowup(
  id: string,
  patch: {
    outcome: FollowupOutcome;
    note: string;
    staff: string;
    /** 넘기지 않으면 그대로 둡니다. null 을 넘기면 안심 기간을 **없앱니다**(목록 복귀). */
    snoozeUntil?: string | null;
    /** 넘기지 않으면 그대로 둡니다. null 을 넘기면 갈래를 비웁니다(종결·보류 해제). */
    resultKind?: ResultKind | null;
    /** 넘기지 않으면 그대로 둡니다. */
    resumeExpected?: string | null;
    /** 넘기지 않으면 그대로 둡니다. null 을 넘기면 반응을 지웁니다. */
    reaction?: FollowupReaction;
    /** 넘기지 않으면 그대로 둡니다. 빈 문자열을 넘기면 지웁니다. */
    reactionNote?: string;
  },
) {
  const before = FOLLOWUPS.find((f) => f.id === id);
  if (!before) return { ok: false as const, error: "이미 없는 기록입니다" };
  const after: Followup = { ...before, ...patch };
  FOLLOWUPS = FOLLOWUPS.map((f) => (f.id === id ? after : f));
  notify();
  // migration_018/022 이후에만 있는 칸이라, **고치라고 넘긴 것만** 보냅니다.
  //
  // addFollowup 은 원래 이 규칙을 지키고 있었는데(값이 있을 때만 payload 에 넣기),
  // 여기는 항상 세 칸을 보내게 만들어 뒀습니다. 마이그레이션을 안 돌린 환경에서는
  // **모든 기록 수정이 실패합니다** — 글자 하나 고치려다 저장이 통째로 거부됩니다.
  // 「목록으로 되돌리기」는 null 을 명시적으로 보내야 하므로, patch 에 키가 들어
  // 있는지로 가릅니다(값이 null 인 것과 안 넘긴 것은 다릅니다).
  const payload: Record<string, unknown> = {
    outcome: after.outcome,
    note: after.note,
    staff: after.staff,
  };
  if ("snoozeUntil" in patch) payload.snooze_until = after.snoozeUntil;
  if ("resultKind" in patch) payload.result_kind = after.resultKind;
  if ("resumeExpected" in patch) payload.resume_expected = after.resumeExpected;
  if ("reaction" in patch) payload.reaction = after.reaction;
  if ("reactionNote" in patch) payload.reaction_note = after.reactionNote || null;
  const { error } = await supabase.from("followups").update(payload).eq("id", id);
  if (error) {
    console.error("대응 이력 수정 실패", error);
    FOLLOWUPS = FOLLOWUPS.map((f) => (f.id === id ? before : f)); // 실패 시 되돌림
    notify();
    return { ok: false as const, error: error.message };
  }
  return { ok: true as const };
}

// 잘못 남긴 확인 기록을 지웁니다. 되돌릴 수 없으니 화면에서 한 번 확인받은 뒤 부릅니다.
/** 확인 기록을 지웁니다. updateFollowup 과 같은 이유로 **성공 여부를 돌려줍니다.** */
export async function deleteFollowup(id: string) {
  const before = FOLLOWUPS.find((f) => f.id === id);
  if (!before) return { ok: false as const, error: "이미 없는 기록입니다" };
  FOLLOWUPS = FOLLOWUPS.filter((f) => f.id !== id); // 낙관적으로 먼저 화면에서 제거
  notify();
  const { error } = await supabase.from("followups").delete().eq("id", id);
  if (error) {
    console.error("대응 이력 삭제 실패", error);
    FOLLOWUPS = [before, ...FOLLOWUPS]; // 실패 시 되돌림
    notify();
    return { ok: false as const, error: error.message };
  }
  return { ok: true as const };
}

// ── 어드민: 어르신 등록/수정/퇴소 ────────────────────────────────

export function addResident(input: {
  name: string;
  ageGroup: string;
  phone: string;
  notes: string;
}): Resident {
  const existingIds = residents.map((r) => Number(r.id.replace("a-", "")) || 0);
  const nextIndex = (existingIds.length ? Math.max(...existingIds) : 0) + 1;
  const id = `a-${String(nextIndex).padStart(2, "0")}`;
  const resident: Resident = {
    id,
    watchStatus: "감시중",
    resumeExpected: null,
    downgradeCount: 0,
    name: input.name,
    ageGroup: input.ageGroup,
    phone: input.phone,
    registeredAt: DATA_END_STR,
    notes: input.notes,
    status: "active",
    // 새로 등록하는 분은 결제 기록이 아직 없으니 일반으로 둡니다. 앤컴 자료를 다시
    // 불러오면 실제 구분으로 바뀝니다.
    mealTier: "일반",
    aiSummary: undefined,
    aiSummaryAt: undefined,
    aiNeedsUpdate: true,
    attendance: {},
  };
  residents = [...residents, resident];
  notify();
  supabase
    .from("residents")
    .insert({
      id,
      name: resident.name,
      age_group: resident.ageGroup,
      caseworker: "",
      phone: resident.phone,
      registered_at: resident.registeredAt,
      notes: resident.notes,
      status: resident.status,
    })
    .then(({ error }) => {
      if (error) {
        console.error("어르신 등록 실패", error);
        toast.error("어르신 등록에 실패했습니다. 네트워크를 확인해주세요.");
      }
    });
  return resident;
}

export function updateResident(
  id: string,
  input: { name: string; ageGroup: string; phone: string; notes: string },
) {
  const resident = getResidentById(id);
  if (!resident) return;
  resident.name = input.name;
  resident.ageGroup = input.ageGroup;
  resident.phone = input.phone;
  resident.notes = input.notes;
  notify();
  supabase
    .from("residents")
    .update({
      name: resident.name,
      age_group: resident.ageGroup,
      caseworker: "",
      phone: resident.phone,
      notes: resident.notes,
    })
    .eq("id", id)
    .then(({ error }) => {
      if (error) {
        console.error("어르신 정보 수정 실패", error);
        toast.error("어르신 정보 수정에 실패했습니다. 네트워크를 확인해주세요.");
      }
    });
}

export function setResidentStatus(id: string, status: ResidentStatus) {
  const resident = getResidentById(id);
  if (!resident) return;
  resident.status = status;
  notify();
  supabase
    .from("residents")
    .update({ status })
    .eq("id", id)
    .then(({ error }) => {
      if (error) {
        console.error("어르신 상태 변경 실패", error);
        toast.error("어르신 상태 변경에 실패했습니다. 네트워크를 확인해주세요.");
      }
    });
}

const RESIDENT_PHOTO_BUCKET = "resident-photos";
// 열람 주소가 살아 있는 시간. 화면을 오래 켜두는 근무 형태를 감안해 넉넉히 두되, 주소가
// 새어나가도 하루를 못 넘기게 합니다.
const PHOTO_URL_TTL_SECONDS = 60 * 60 * 2;

// 실제 사진 파일을 Supabase Storage에 업로드하고, 공개 URL을 어르신 레코드에 저장합니다.
// 반환값은 성공 여부 — 호출 쪽에서 성공/실패에 따라 다른 안내를 보여줄 수 있도록 합니다.
export async function uploadResidentPhoto(residentId: string, file: File): Promise<boolean> {
  const resident = getResidentById(residentId);
  if (!resident) return false;

  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `${residentId}-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(RESIDENT_PHOTO_BUCKET)
    .upload(path, file, { upsert: true });
  if (uploadError) {
    console.error("사진 업로드 실패", uploadError);
    toast.error("사진 업로드에 실패했습니다. Storage 버킷 설정을 확인해주세요.");
    return false;
  }

  // 공개 URL(getPublicUrl)을 쓰지 않습니다.
  //
  // 공개 URL은 만료가 없고 접근 정책도 거치지 않습니다. 한 번 주소가 새어나가면 — 브라우저
  // 기록, 카톡으로 보낸 링크, 퇴사한 직원의 기기 — 승인을 취소하든 계정을 지우든 그 사진은
  // 영원히 열립니다. 어르신 얼굴 사진에 그런 주소를 붙일 수는 없습니다.
  //
  // 그래서 표에는 **경로만** 저장하고, 화면에 보여줄 때마다 짧게 사는 서명 주소를 새로
  // 발급합니다(loadResidentPhotoUrls).
  const previousPath = resident.photoUrl ? extractStoragePath(resident.photoUrl) : null;

  resident.photoUrl = await signPhotoPath(path);
  notify();

  const { error: updateError } = await supabase
    .from("residents")
    .update({ photo_url: path })
    .eq("id", residentId);
  if (updateError) {
    console.error("사진 URL 저장 실패", updateError);
    toast.error("사진 정보를 저장하는 데 실패했습니다. 네트워크를 확인해주세요.");
    return false;
  }

  if (previousPath) {
    await supabase.storage.from(RESIDENT_PHOTO_BUCKET).remove([previousPath]);
  }
  return true;
}

// 실제 사진을 지우고 다시 일러스트 아바타로 되돌립니다.
export async function removeResidentPhoto(residentId: string): Promise<boolean> {
  const resident = getResidentById(residentId);
  if (!resident || !resident.photoUrl) return false;

  const previousPath = extractStoragePath(resident.photoUrl);
  resident.photoUrl = undefined;
  notify();

  const { error } = await supabase
    .from("residents")
    .update({ photo_url: null })
    .eq("id", residentId);
  if (error) {
    console.error("사진 삭제 실패", error);
    toast.error("사진 삭제에 실패했습니다. 네트워크를 확인해주세요.");
    return false;
  }
  if (previousPath) {
    await supabase.storage.from(RESIDENT_PHOTO_BUCKET).remove([previousPath]);
  }
  return true;
}

// 저장된 값에서 파일 경로를 꺼냅니다.
//
// 지금은 경로만 저장하지만, 예전에 저장된 공개 URL과 화면이 들고 있는 서명 URL도 들어올 수
// 있습니다. 셋 다 받아냅니다 — 여기서 못 알아보면 예전 사진 파일이 지워지지 않고 남습니다.
function extractStoragePath(value: string): string | null {
  for (const marker of [
    `/object/public/${RESIDENT_PHOTO_BUCKET}/`,
    `/object/sign/${RESIDENT_PHOTO_BUCKET}/`,
  ]) {
    const idx = value.indexOf(marker);
    if (idx !== -1) return value.slice(idx + marker.length).split("?")[0];
  }
  // 주소가 아니면 경로 그 자체입니다.
  return value.includes("://") ? null : value;
}

/** 경로 하나에 대해 짧게 사는 열람 주소를 만듭니다. */
async function signPhotoPath(path: string): Promise<string | undefined> {
  const { data, error } = await supabase.storage
    .from(RESIDENT_PHOTO_BUCKET)
    .createSignedUrl(path, PHOTO_URL_TTL_SECONDS);
  if (error) {
    console.error("사진 주소를 발급하지 못했습니다.", error.message);
    return undefined;
  }
  return data.signedUrl;
}

/**
 * 어르신 목록을 받아온 뒤, 사진이 있는 분들의 열람 주소를 한 번에 발급합니다.
 *
 * 한 장씩 발급하면 사진 있는 분이 100명일 때 요청이 100번 나갑니다. 스토리지가 여러 개를
 * 한 번에 서명해주는 기능을 제공하므로 그것을 씁니다.
 */
async function loadResidentPhotoUrls(): Promise<void> {
  const withPhoto = residents.filter((r) => r.photoUrl);
  if (withPhoto.length === 0) return;
  const paths = withPhoto
    .map((r) => extractStoragePath(r.photoUrl as string))
    .filter((p): p is string => !!p);
  if (paths.length === 0) return;

  const { data, error } = await supabase.storage
    .from(RESIDENT_PHOTO_BUCKET)
    .createSignedUrls(paths, PHOTO_URL_TTL_SECONDS);
  if (error || !data) {
    console.error("사진 주소를 발급하지 못했습니다.", error?.message);
    return;
  }
  const byPath = new Map(data.map((d) => [d.path ?? "", d.signedUrl]));
  for (const r of withPhoto) {
    const path = extractStoragePath(r.photoUrl as string);
    // 발급이 안 된 사진은 주소를 비웁니다. 열리지 않는 주소를 남겨두면 화면에 깨진 이미지가
    // 뜨는데, 그러면 사진이 지워진 것인지 잠깐 안 열리는 것인지 구분할 수가 없습니다.
    r.photoUrl = (path && byPath.get(path)) || undefined;
  }
  notify();
}

// ── 어드민: 담당 직원 관리 ────────────────────────────────────

export function addStaffMember(name: string) {
  const trimmed = name.trim();
  if (!trimmed || STAFF_MEMBERS.includes(trimmed)) return;
  STAFF_MEMBERS = [...STAFF_MEMBERS, trimmed].sort();
  notify();
  supabase
    .from("staff")
    .insert({ name: trimmed })
    .then(({ error }) => {
      if (error) {
        console.error("직원 추가 실패", error);
        toast.error("직원 추가에 실패했습니다. 네트워크를 확인해주세요.");
      }
    });
}

export function removeStaffMember(name: string) {
  STAFF_MEMBERS = STAFF_MEMBERS.filter((s) => s !== name);
  notify();
  supabase
    .from("staff")
    .delete()
    .eq("name", name)
    .then(({ error }) => {
      if (error) {
        console.error("직원 삭제 실패", error);
        toast.error("직원 삭제에 실패했습니다. 네트워크를 확인해주세요.");
      }
    });
}

// ── 어드민: 공휴일 관리 ──────────────────────────────────────

export function addHoliday(date: string, label: string) {
  const trimmed = label.trim();
  if (!date || !trimmed) return;
  const next = new Map(HOLIDAY_LABELS);
  next.set(date, trimmed);
  HOLIDAY_LABELS = next;
  recomputeExternalFactors();
  notify();
  supabase
    .from("holidays")
    .upsert({ date, label: trimmed })
    .then(({ error }) => {
      if (error) {
        console.error("공휴일 추가 실패", error);
        toast.error("공휴일 추가에 실패했습니다. 네트워크를 확인해주세요.");
      }
    });
}

export function removeHoliday(date: string) {
  const next = new Map(HOLIDAY_LABELS);
  next.delete(date);
  HOLIDAY_LABELS = next;
  recomputeExternalFactors();
  notify();
  supabase
    .from("holidays")
    .delete()
    .eq("date", date)
    .then(({ error }) => {
      if (error) {
        console.error("공휴일 삭제 실패", error);
        toast.error("공휴일 삭제에 실패했습니다. 네트워크를 확인해주세요.");
      }
    });
}

// ── 출석률 / 위험등급 계산 ──────────────────────────────────────

export interface MonthlyStats {
  total: number;
  present: number;
  absent: number;
  rate: number;
}

// 외부변수로 설명되는 날은 빼고 셉니다.
//
// 원래는 그 달에 기록된 날을 전부 셌습니다. 그런데 위기·주의 등급은 외부변수를 뺀 기준으로
// 매기고 있어서, 등급 바로 옆에 붙는 "출석률 62%"만 빼지 않은 숫자였습니다. 담당자가
// 화면에서 보는 두 숫자가 서로 다른 잣대로 계산된 셈이고, "출석률이 이만한데 왜 위기지"
// 하고 판단을 못 믿게 만듭니다. 외부변수 스위치를 켜고 꺼도 이 숫자만 꿈쩍하지 않았습니다.
//
// 뺀다는 것은 분자·분모에서 함께 빠진다는 뜻입니다. 그날은 나오기 어려웠던 날이므로
// 출석 기회로 세지 않습니다.
export function getMonthlyStats(resident: Resident, year: number, month: number): MonthlyStats {
  const prefix = `${year}-${pad2(month)}`;
  const days = opportunityDays(resident, `${prefix}-01`, `${prefix}-31`);
  let present = 0;
  for (const d of days) if (resident.attendance[d]) present++;
  const total = days.length;
  const rate = total > 0 ? Math.round((present / total) * 1000) / 10 : 0;
  return { total, present, absent: total - present, rate };
}

// 주말·공휴일·기관 전체 결석 급증일은 건너뛰고(그 어르신의 책임으로 보지 않고) 셉니다.
export function getConsecutiveAbsence(
  resident: Resident,
  asOfDateStr: string = DATA_END_STR,
): number {
  // 운영일을 뒤에서부터 거슬러 올라갑니다. 오신 날을 만나면 거기서 멈춥니다.
  //
  // 다만 **사람이 몰린 행사일에 오신 것은 복귀로 보지 않습니다.**
  //
  // 무료급식 행사나 초복에는 평소의 두 배가 오십니다(828명, 752명). 석 달을 안 나오시던
  // 분이 그날 하루 오셨다면, 그것은 다시 다니기 시작하신 것이 아니라 특식을 드시러 한 번
  // 들르신 것에 가깝습니다. 그런데 그 하루가 연속결석을 0으로 되돌려버리면, 계속 끊겨
  // 있는 분이 화면에서 사라집니다. 실제로 이런 분이 적지 않습니다.
  //
  // 그래서 그날은 끊지도, 결석으로 세지도 않고 건너뜁니다. 대신 왜 건너뛰었는지를
  // getEventOnlyVisits 로 화면에 그대로 보여줍니다 — 조용히 무시하면 안 됩니다.
  const days = opportunityDays(resident, DATA_START_STR, asOfDateStr);
  let count = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (resident.attendance[d]) {
      if (CROWD_DAYS.has(d)) continue;
      break;
    }
    count++;
  }
  return count;
}

/**
 * 지금 이어지고 있는 결석 구간 안에서 "행사일에만 오신 날"을 돌려줍니다.
 *
 * getConsecutiveAbsence 가 건너뛴 날이 바로 이 날들입니다. 건너뛴 사실을 화면에 적어야
 * 담당자가 "왜 100일 연속결석이라면서 7월에 온 기록이 있지?"에 스스로 답할 수 있습니다.
 */
export function getEventOnlyVisits(
  resident: Resident,
  asOfDateStr: string = DATA_END_STR,
): { date: string; label: string }[] {
  const days = opportunityDays(resident, DATA_START_STR, asOfDateStr);
  const out: { date: string; label: string }[] = [];
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (!resident.attendance[d]) continue;
    if (!CROWD_DAYS.has(d)) break; // 평범한 날에 오셨으면 거기서 구간이 끝납니다
    out.push({ date: d, label: getMenuEvent(d) ?? "행사" });
  }
  return out;
}

// 특정 구간(rangeStart~rangeEnd, 둘 다 포함)의 출석률을 계산합니다. 개인별 "평소 패턴" 기준선을
// 구할 때 사용합니다. 공휴일·기관 전체 결석 급증일은 "기회일수" 자체에서 제외합니다.
function getRateForRange(
  resident: Resident,
  rangeStart: Date,
  rangeEnd: Date,
): { present: number; total: number; rate: number } {
  if (rangeStart > rangeEnd) return { present: 0, total: 0, rate: 0 };
  const days = opportunityDays(resident, toDateStr(rangeStart), toDateStr(rangeEnd));
  let present = 0;
  for (const d of days) if (resident.attendance[d]) present++;
  const total = days.length;
  const rate = total > 0 ? Math.round((present / total) * 1000) / 10 : 0;
  return { present, total, rate };
}

// 특정 구간에서 결석이 이어진 "연속결석 구간"들의 평균 길이를 구합니다. 이 어르신이 평소에도
// 결석하면 보통 며칠씩 이어지는지를 나타내는 개인별 기준선입니다. 공휴일·전체 결석 급증일은
// 건너뛰어(구간을 끊지도, 늘리지도 않고) 계산합니다.
function getAverageAbsenceStreak(resident: Resident, rangeStart: Date, rangeEnd: Date): number {
  const runs: number[] = [];
  let current = 0;
  if (rangeStart <= rangeEnd) {
    for (const d of opportunityDays(resident, toDateStr(rangeStart), toDateStr(rangeEnd))) {
      if (resident.attendance[d]) {
        if (current > 0) runs.push(current);
        current = 0;
      } else {
        current++;
      }
    }
  }
  if (current > 0) runs.push(current);
  if (runs.length === 0) return 0;
  return runs.reduce((s, v) => s + v, 0) / runs.length;
}

export interface AiRiskAssessment {
  level: RiskLevel;
  /**
   * 사유를 확인해 기한을 걸기 **전**의 등급.
   *
   * 없으면 카드와 명단이 어긋납니다 — 「9월 긴급 11명」을 눌렀는데 4명만 나오고,
   * 회원관리에서는 그분들이 등급 「정상」으로 섞여 나옵니다. 가린 것과 괜찮아진 것은
   * 다릅니다. 읽는 쪽은 `levelBeforeSnooze ?? level` 로 씁니다.
   */
  levelBeforeSnooze?: RiskLevel;
  attendanceRate: number;
  baselineRate: number;
  /** "평소 주 N회쯤" 을 적을 때 쓰는 값(마지막 방문일 기준). 판정에는 안 씁니다. */
  habitRate: number;
  recentRate: number;
  rateDeviation: number;
  consecutiveAbsence: number;
  typicalAbsenceStreak: number;
  streakDeviation: number;
  patternBreak: boolean;
  /**
   * 출결로 판단할 수 있는 분인지. 평소에 어쩌다 한 번 오시는 분은 "안 오셨다"가 신호가
   * 되지 않습니다 — 그게 원래 모습이기 때문입니다. false면 아래 등급을 위기 판단에
   * 쓰지 않습니다.
   */
  isRegularUser: boolean;
  /** 설정한 기준보다 오래 안 나오신 분. 위기 목록에서 빼고 "장기 미이용"으로 따로 셉니다. */
  isLongAbsent: boolean;
  /** 이어지는 결석 구간 안에서 "행사일에만 오신" 날들. 왜 연속결석이 안 끊겼는지 설명합니다. */
  eventOnlyVisits: { date: string; label: string }[];
  reasons: string[];
  narrative: string;
}

const RISK_RECOMMENDATION: Record<RiskLevel, string> = {
  crisis: "즉각적인 안부 확인과 가정방문이 필요한 긴급 단계로 판단됩니다.",
  caution: "이번 주 안에 안부 전화나 방문으로 확인이 필요한 위기 단계로 판단됩니다.",
  concern: "다음 방문 때 컨디션을 한 번 더 살펴볼 필요가 있는 관심 단계로 판단됩니다.",
  normal: "특별한 조치 없이 정기 관찰을 유지해도 되는 정상 단계로 판단됩니다.",
  // 판단하지 않은 분께는 권고를 적지 않습니다. 적을 근거가 없으니까요.
  unknown:
    "평소 급식 이용이 워낙 드물어 급식 기록만으로는 판단하기 어렵습니다. 기존 방식대로 안부를 확인해 주세요.",
};

const RECENT_WINDOW_DAYS = 30;

// "정기적으로 오시는 분"의 기준. 운영일의 20% = 주 1회쯤입니다.
//
// 실제 자료로 확인한 숫자(2026년 1~8월, 2,828명 기준):
//   이 선 없이      → 위기 878명 (31%)   ← 아무도 못 보는 목록
//   평소 20% 이상   → 691명 중 위기 105명 · 주의 75명
//   평소 30% 이상   → 481명 중 위기  57명 · 주의 47명
//   평소 40% 이상   → 351명 중 위기  40명 · 주의 27명
// 기관 사정에 맞춰 올리고 내리시면 됩니다. 올릴수록 놓치는 분이 생기고,
// 내릴수록 목록이 길어져 아무도 안 보게 됩니다.
// 정기 이용자 기준은 external-factors.ts 에 있습니다(화면에서 조절, Supabase에 저장).
// getRegularUserMinRate() 로 읽습니다.

function describeBaselineLevel(rate: number): string {
  if (rate >= 85) return "매우 꾸준하게 참여해 오신";
  if (rate >= 70) return "안정적으로 참여해 오신";
  if (rate >= 50) return "다소 기복이 있지만 나름의 패턴을 유지해 오신";
  return "원래도 출석이 잦지 않았던";
}

// "결석 N일 = 위험군"처럼 모두에게 같은 절대 기준을 적용하는 대신, 각 어르신의 지난 약 6개월
// 출석 패턴(평소 출석률·평소 결석 지속 기간)을 개인별 기준선으로 삼고, 최근 한 달의 행동이 그
// 기준선에서 얼마나 벗어났는지(평소와 다른 변화)를 살펴, 공휴일·기관 전체 결석 급증일 같은
// 외부요인을 빼고 최종
// 위기 단계와 서술형 분석 코멘트를 만들어내는 AI 분석 시뮬레이션입니다.
/**
 * 등급만 필요할 때 쓰는 가벼운 판정.
 *
 * 통계 화면의 월별 추이는 21개월 × 400명 = 8,400번 판정합니다. 그런데 getCurrentRisk 는
 * 속으로 getAiRiskAssessment 를 불러 **설명 문장까지 전부 만들어냅니다** — 메모를 훑고
 * 문장을 조립한 뒤 등급 한 글자만 꺼내 쓰고 버립니다. 통계 화면이 6초 동안 백지였던
 * 이유가 이것입니다. 등급만 쓸 자리에서는 이쪽을 부릅니다.
 */
export function getRiskLevelAt(resident: Resident, at: Date = TODAY_DATE): RiskLevel {
  const clampedAt = at > DATA_END_DATE ? DATA_END_DATE : at;
  return classifyRisk(resident, toDateStr(clampedAt)).level;
}

export function getAiRiskAssessment(resident: Resident, at: Date = TODAY_DATE): AiRiskAssessment {
  const clampedAt = at > DATA_END_DATE ? DATA_END_DATE : at;
  // 위기·주의 등급은 화면 전체가 공유하는 단일 기준(classifyRisk)에서 나옵니다.
  // 아래 서술형 코멘트·이유는 이 등급을 설명하기 위한 부가 정보입니다.
  const classification = classifyRisk(resident, toDateStr(clampedAt));
  const stats = getMonthlyStats(resident, clampedAt.getFullYear(), clampedAt.getMonth() + 1);

  // 1) 개인별 기준선: 최근 30일을 제외한 나머지 전체 기간(자료가 있는 첫날부터, 2025년 포함)의
  //    평소 출석률·평소 결석 지속 기간
  const recentStart = addDays(clampedAt, -(RECENT_WINDOW_DAYS - 1));
  const baselineEnd = addDays(recentStart, -1);
  const baseline = getRateForRange(resident, DATA_START, baselineEnd);
  const recent = getRateForRange(resident, recentStart, clampedAt);
  const hasBaseline = baseline.total >= 14; // 기준선을 신뢰할 만큼 과거 데이터가 있는지

  // 출결로 판단할 수 있는 분인지 먼저 가립니다.
  //
  // 이 도구의 전제는 "평소 오시던 분이 안 오시면 무슨 일이 있는 것"입니다. 그 전제는
  // 평소 오시던 분에게만 성립합니다. 실제 자료를 넣어보니 2,828분 중 절반이 8개월에
  // 다섯 번 이하 오셨고, 그분들께는 "연속결석 30일"이 이상 신호가 아니라 평소 모습입니다.
  //
  // 이 구분 없이 돌리면 2,828분 중 878분(31%)이 위기로 잡힙니다. 사례관리 직원 네 분이
  // 878명을 찾아갈 수는 없고, 그 목록은 결국 아무도 안 보게 됩니다. 진짜 위기 한 분이
  // 878명 속에 묻히는 것이 가장 나쁜 결과입니다.
  //
  // 그래서 평소 출석률이 이 선에 못 미치면 등급을 매기지 않습니다. 자료에서 빼는 것이
  // 아니라 "출결로는 판단하지 않는다"고 화면에 적습니다 — 이분들은 확인 기록이나 다른
  // 경로로 살펴야 합니다.
  //
  // 기준선이 없으면(=비교할 과거가 3주도 안 되면) 판단하지 않습니다. 처음에는 "모를 때는
  // 일단 본다"는 뜻으로 통과시켰는데, 그러면 최근에 한 번 오신 분이 전부 통과해 위기
  // 376명이 나옵니다. 모른다는 것은 통과가 아니라 판단 보류입니다.
  const regularMin = getRegularUserMinRate();
  // ★ 조건에 쓰는 값과 화면에 적는 값이 **같아야** 합니다.
  //
  //   화면에 "평소 출석률이 52%로 낮아(기준 50% 미만)"이 떴습니다. 52는 50보다 큽니다.
  //   읽는 사람 입장에서 이 한 줄이면 나머지 판정도 못 믿습니다.
  //
  //   원인은 두 개의 서로 다른 "평소"였습니다. 문턱을 넘는지는 **전체 기간 평균**으로
  //   재고, 화면에는 **직전 60 운영일 기준선**을 적었습니다. 아래 주석이 "화면도 판정과
  //   같은 값을 쓴다"고 해놓고 정작 문턱만 옛 값에 남아 있었습니다.
  //
  //   사양 4장의 기준선은 직전 60 운영일입니다. 문턱도 그 값으로 잽니다.
  // ★ 「이분이 평소 급식을 자주 쓰시던 분인가」는 **habitRate** 로 잽니다.
  //
  //   baselineRate(오늘 이전 60운영일)로 재면, 결석이 길어질수록 값이 깎여 어느 순간
  //   자기 자신과 모순됩니다. 실제 화면입니다(이○룡 어르신, 마지막 방문 7/15) —
  //
  //     평소 출석률 (마지막 방문일까지 60일)   68%
  //     · 평소 급식 이용이 잦지 않은 편이라(최근 3%) 신호가 늦게 잡힐 수 있습니다
  //     · 최근 30일 출석률 0% (평소 3%)
  //
  //   한 화면 안에서 「평소」가 68%이자 3%입니다. 대시보드는 같은 분을 "주 3회쯤
  //   오시던 분"이라 부릅니다. 담당자가 어느 숫자를 믿어야 할지 알 수 없습니다.
  //
  //   habitRate 는 마지막으로 오신 날까지의 창이라 결석이 길어져도 안 깎입니다 —
  //   "원래 어떤 분이었나"라는 이 질문에 맞는 값입니다.
  const judgedBaselineRate = classification.habitRate;
  const isRegularUser = hasBaseline && judgedBaselineRate >= regularMin;
  // ★ "평소 출석률"은 판정에 쓰는 것과 **같은 값**이어야 합니다.
  //
  //   예전에는 여기서 전체 기간 평균을 따로 구해 "평소 N%"로 적었습니다. 그래서 같은
  //   어르신이 대시보드에서는 "평소 13%", 상세 화면에서는 "평소 80.7% — 안정적으로
  //   참여해 오신 분"으로 보였습니다(32명 중 22명이 5%p 이상 차이). 둘 다 "평소"라는
  //   같은 말을 쓰니 담당자는 어느 쪽도 믿을 수 없습니다.
  //
  //   판정이 쓰는 값은 사양 4장의 직전 60 운영일 기준선이므로, 화면도 그것을 씁니다.
  const baselineRate = classification.baselineRate;
  const habitRate = classification.habitRate;
  const recentRate = recent.rate;
  const rateDeviation = Math.max(0, Math.round((baselineRate - recentRate) * 10) / 10);

  const typicalAbsenceStreak = hasBaseline
    ? getAverageAbsenceStreak(resident, DATA_START, baselineEnd)
    : 0;
  const consecutiveAbsence = classification.consecutiveAbsence;
  const streakDeviation = Math.max(
    0,
    Math.round(consecutiveAbsence - (typicalAbsenceStreak * 1.5 + 2)),
  );

  const patternBreak = rateDeviation >= 15 || streakDeviation >= 3;

  // 2) 외부요인으로 설명되는 날(공휴일·기관 전체 결석 급증일)은 개인 책임으로 보지 않습니다.
  let excludedRecentDays = 0;
  {
    let cursor = new Date(recentStart);
    while (cursor <= clampedAt) {
      if (EXTERNALLY_EXPLAINED_DATES.has(toDateStr(cursor))) excludedRecentDays++;
      cursor = addDays(cursor, 1);
    }
  }

  // 위기·주의 등급은 화면 전체 공통 기준(classifyRisk)이 정합니다.
  //   early → "crisis"(지금 먼저 연락), welfare → "caution"(오래 끊긴 정기이용자 · 안부확인).
  // 여기서 다시 계산하지 않으므로 KPI·조기개입 목록·추이·리포트가 항상 같은 숫자를 냅니다.
  // 목록 이관과 **같은 경계**를 씁니다. 예전에는 이 줄만 관리자 설정값(7)을 보고,
  // 목록은 BASELINE_DAYS(60)를 봐서 서로 다른 「장기」가 두 개 있었습니다.
  const isLongAbsent = consecutiveAbsence > getLongAbsenceBoundary();
  const level = classification.level;
  const eventOnlyVisits = getEventOnlyVisits(resident, toDateStr(clampedAt));

  // 「평소」는 habitRate, 「최근 N일」은 baselineRate — 두 값에 같은 이름을 붙이지
  // 않습니다. 셋을 나란히 적어 무엇과 무엇을 견주는지 한 줄에서 보이게 합니다.
  // 판정을 멈춘 분께는 0% 를 늘어놓지 않습니다. 판정 함수가 담아 돌려주는 0 일 뿐,
  // 실제로 한 번도 안 오셨다는 뜻이 아닙니다 — 화면 위 배너가 왜 멈췄는지 말합니다.
  const judgedHere =
    classification.bucket !== "notEnough" && classification.bucket !== "undetectable";
  const reasons: string[] = judgedHere
    ? [
        `최근 30일 출석률 ${recentRate}% · 최근 ${BASELINE_DAYS}일 ${baselineRate}% (평소 ${habitRate}%)`,
      ]
    : [];
  if (isLongAbsent) {
    reasons.unshift(
      // 「분류했습니다」라고 쓰면 안 됩니다 — 이 값은 **아무 판정도 바꾸지 않습니다.**
      // 근거 문장 한 줄을 만드는 것이 전부입니다(isLongAbsent 의 유일한 쓰임).
      //
      // 게다가 대시보드에는 「📦 오래 안 나오시는 분 — 석 달 넘게」 상자가 따로 있습니다.
      // 그쪽 경계는 기준선 창(60 운영일)이고, 이 문장의 기준은 관리자 화면에서 정하는
      // 별개 설정값입니다. 둘 다 "장기"라고 부르면 같은 것으로 읽힙니다.
      `기준선을 재는 ${getLongAbsenceBoundary()} 운영일을 통째로 넘겨 ${consecutiveAbsence}번의 운영일 동안 한 번도 안 오셔서, 급식 기록으로는 더 판단하지 않습니다`,
    );
  }
  if (eventOnlyVisits.length > 0) {
    reasons.push(
      `그 사이 ${eventOnlyVisits.map((v) => `${v.date.slice(5)} ${v.label}`).join(", ")}에 오셨지만, 사람이 몰린 행사일이라 복귀로 세지 않았습니다`,
    );
  }
  // ⚠️ "판단하지 않습니다"는 **판단하지 않을 때만** 적습니다.
  //
  //   isRegularUser 는 어떤 판정도 막지 않습니다 — 근거 문장만 만드는 값입니다. 그런데
  //   그 문장이 reasons 맨 앞에 붙었습니다. 실제로 이런 화면이 나왔습니다 —
  //
  //     🔴 위기   86일째 안 나오십니다
  //     · 평소 급식 이용률이 8%로 기준(40%)에 못 미쳐, 급식 기록만으로는 판단하지 않습니다
  //
  //   판정은 마지막 방문일 기준 창(문턱 7%)으로, 문장은 오늘 기준 창(문턱 40%)으로
  //   쟀기 때문입니다. 담당자가 첫 줄을 읽고 "판단 대상이 아니구나" 하고 넘기면,
  //   86일째 연락 안 되는 무료급식 어르신을 건너뜁니다.
  //
  //   판단을 실제로 멈추는 것은 tier 입니다(관측불가 → 판단 어려움). 판정이 나온 분께는
  //   "평소 이용이 드물어 늦게 잡힐 수 있다"는 **주의**만 적고, 판단을 안 했다고 말하지
  //   않습니다.
  if (!hasBaseline) {
    // ★ **판정이 나온 분께 「판단하기 어렵습니다」라고 쓰지 않습니다.**
    //
    //   바로 위 주석이 그렇게 하기로 적어 두었는데 코드가 지키지 않고 있었습니다.
    //   그래서 대시보드 긴급 1순위 어르신의 근거 첫 줄이 이렇게 나왔습니다 —
    //     [긴급]  비교할 지난 기록이 아직 3주에 못 미쳐, 급식 기록만으로는
    //             판단하기 어렵습니다
    //   그리고 그 문장이 연계 의뢰서의 「긴급」 도장 바로 아래에 인쇄됩니다.
    //   판정 기준 화면은 「3주에 못 미치면 점수를 내지 않습니다」라고 적어 두었으니,
    //   읽는 사람에게는 도구가 자기 규칙을 어기는 것으로 보입니다.
    //
    //   실제로 판단을 멈추는 문턱은 여기(14 운영일)가 아니라 classifyRisk 의
    //   20 운영일입니다. 여기서 걸린 분은 「자료가 얕아 근거가 약하다」는 뜻이지
    //   「판단하지 않았다」는 뜻이 아닙니다. 판정이 나왔으면 그렇게 적습니다.
    reasons.unshift(
      classification.level === "unknown"
        ? "비교할 지난 기록이 아직 3주에 못 미쳐, 급식 기록만으로는 판단하기 어렵습니다"
        : "견줄 지난 기록이 아직 얼마 안 되어(3주 미만) 이 판단은 근거가 얕습니다 — 다른 경로로도 확인해 주세요",
    );
  } else if (!isRegularUser) {
    reasons.push(
      `평소 급식 이용이 잦지 않은 편이라(${judgedBaselineRate}%) 신호가 늦게 잡힐 수 있습니다`,
    );
  }
  // 요일 리듬은 **연속결석 바로 다음**에 적습니다. "19일째"만으로는 그 19일이 이분께
  // 무슨 뜻인지 알 수 없지만, "금요일 3번 건너뛰셨다"는 바로 와닿습니다.
  {
    const dow = describeDowPattern(classification.dowPattern);
    if (dow) reasons.push(dow);
  }
  if (classification.rhythmBreak) {
    reasons.push(
      `평소 이분은 결석하셔도 가장 길 때가 ${classification.usualMaxGap}일이었는데, 지금 ${consecutiveAbsence}일째입니다 — 평소 리듬을 넘겨 등급을 한 단계 올렸습니다`,
    );
  }
  if (patternBreak) reasons.push("평소와 다른 변화가 보입니다");
  if (consecutiveAbsence > 0) reasons.push(`현재 ${consecutiveAbsence}일 연속 결석 중`);
  if (excludedRecentDays > 0) {
    reasons.push(`공휴일·기관 전체 결석 급증일 ${excludedRecentDays}일은 계산에서 제외`);
  }

  // ── 서술형 코멘트 생성 (그분의 평소 리듬과 지금을 견줘 문장으로 풉니다) ──
  const sentences: string[] = [];

  if (!hasBaseline) {
    sentences.push(
      `아직 비교할 만한 지난 기록이 충분하지 않아, 최근 30일 출석률(${recentRate}%)을 기준으로 살펴봤습니다.`,
    );
  } else {
    const streakBaselineDesc =
      typicalAbsenceStreak > 0
        ? `결석하시더라도 평균 ${Math.round(typicalAbsenceStreak * 10) / 10}일 이내에 다시 나오시는 패턴을 보여왔습니다.`
        : `결석이 거의 없을 정도로 꾸준히 참여해 오셨습니다.`;
    // ⚠️ 「어떤 분이었나」는 habitRate 로 말해야 합니다.
    //
    //   baselineRate 는 **오늘 이전** 60운영일 창입니다. 결석이 길어질수록 그 창이
    //   결석으로 채워져 값이 깎입니다. 그 값으로 사람됨을 말하면, 오래 끊기실수록
    //   문장이 **더 안심시키는 쪽**으로 틀어집니다 — 평소 90%로 꼬박 오시던 분을
    //   실측했습니다(마지막 방문 6/30) —
    //
    //     7/15 조회  결석 11일  baselineRate 75%  "안정적으로 참여해 오신 분"
    //     8/03 조회  결석 24일  baselineRate 57%  "다소 기복이 있지만…"
    //     8/28 조회  결석 43일  baselineRate 28%  "**원래도 출석이 잦지 않았던** 분"
    //
    //   같은 날 대시보드는 「거의 매일 오시던 분인데 43일째」라고 적습니다. 담당자가
    //   그 이름을 눌러 들어오면 정반대 문장을 만납니다. 본인이 아는 사실(이분은 매일
    //   오셨다)과 어긋나는 쪽이 여기라서, 판단 근거 전체를 안 믿게 됩니다.
    //
    //   habitRate 는 **마지막으로 오신 날까지**의 창이라 결석이 길어져도 안 깎입니다.
    //   그게 "평소 어떤 분이었나"의 정직한 답입니다. baselineRate 는 아래 「최근 30일과
    //   견주는」 자리에만 남깁니다.
    sentences.push(
      `평소(마지막으로 오신 날까지 운영일 ${BASELINE_DAYS}일 기준) 이 어르신은 출석률 ${habitRate}%로 ${describeBaselineLevel(habitRate)} 분이며, ${streakBaselineDesc}`,
    );

    const anomalies: string[] = [];
    if (rateDeviation >= 15) {
      anomalies.push(`최근 30일 출석률이 ${recentRate}%로 평소보다 ${rateDeviation}%p 낮아진 점`);
    }
    if (streakDeviation >= 3) {
      anomalies.push(
        `현재 ${consecutiveAbsence}일째 이어지는 연속 결석이 평소 지속 기간(평균 약 ${Math.round(typicalAbsenceStreak)}일)을 크게 초과한 점`,
      );
    }
    if (anomalies.length > 0) {
      sentences.push(
        `그런데 ${anomalies.join(", ")} 등 그동안의 평소 패턴에서 벗어난 이상 신호가 감지되었습니다.`,
      );
    } else if (consecutiveAbsence > 0) {
      sentences.push(
        `최근 30일 출석률(${recentRate}%)과 현재 ${consecutiveAbsence}일 연속 결석 상황 모두 그동안의 평소 패턴 범위 안에서 안정적으로 유지되고 있습니다.`,
      );
    } else {
      sentences.push(
        `최근 30일 출석률(${recentRate}%)도 그동안의 평소 패턴과 큰 차이 없이 안정적으로 유지되고 있습니다.`,
      );
    }
  }

  if (excludedRecentDays > 0) {
    sentences.push(
      `이 기간 중 공휴일·기관 전체 결석 급증일 ${excludedRecentDays}일은 개인 책임으로 보지 않고 계산에서 제외했습니다.`,
    );
  }

  // ⚠️ 행사일 예외는 **모든 화면에서** 설명돼야 합니다.
  //
  //   이 설명은 reasons 에만 있었습니다. 그런데 reasons 를 그리는 화면은 상세와
  //   패턴분석 둘뿐이고, 위기 리포트는 narrative 만, 대시보드 목록은 keywords 만
  //   그립니다. 그 두 화면에서는 이렇게 보였습니다 —
  //
  //     「거의 매일 오시던 분인데 99일째 안 나오십니다 · 마지막 07-15」
  //
  //   99일째인데 마지막 방문이 44일 전입니다. 초복(752명 오신 날)에 한 번 들르신
  //   것을 복귀로 세지 않았기 때문인데, 그 이유가 그 화면엔 없습니다. 담당자는
  //   "7월 15일에 오셨네" 하고 넘기고, 4월부터 끊기신 분을 건너뜁니다.
  if (eventOnlyVisits.length > 0) {
    sentences.push(
      `그 사이 ${eventOnlyVisits.map((v) => `${v.date.slice(5)} ${v.label}`).join(", ")}에 오셨지만, 사람이 몰린 행사일이라 복귀로 세지 않았습니다. 그래서 마지막 방문일과 연속결석 일수가 어긋나 보입니다.`,
    );
  }

  // ★ 뱃지와 **같은 등급**으로 맺습니다.
  //
  //   예전에는 여기서 classification.level (보류를 반영한 뒤의 값)을 썼습니다. 그런데
  //   화면의 뱃지는 levelBeforeSnooze (원래 등급)를 그립니다. 사유를 확인해 잠시
  //   빼둔 분은 두 값이 갈라지므로, 위험군 리포트에 이렇게 찍혔습니다 —
  //
  //     [긴급]  …22일째 이어지는 연속 결석이 평소의 3일을 크게 초과한 점 등
  //             이상 신호가 감지되었습니다. 종합적으로 특별한 조치 없이 정기 관찰을
  //             유지해도 되는 **정상 단계로 판단됩니다.**
  //
  //   운영 화면에서 여덟 분이 이 모양이었습니다. 읽는 사람은 "긴급이라면서 정상이라고
  //   쓴다"고 볼 수밖에 없고, 그 리포트는 행정복지센터·사례관리팀으로 나갑니다.
  //   숫자가 아니라 **한 문장이 도구 전체의 신뢰를 깎는 자리**였습니다.
  const shownLevel = classification.levelBeforeSnooze ?? level;

  // ★ 종결하신 분께는 안부를 확인하라고 적지 않습니다.
  //
  //   운영 화면에서 「사망」으로 확인된 어르신의 카드가 이렇게 끝나고 있었습니다 —
  //     "…배우자와 통화함. 8월에 사망하심."
  //     "평소 급식 이용이 워낙 드물어 … 기존 방식대로 안부를 확인해 주세요."
  //   그 옆에는 「연계 의뢰서」 단추가 그대로 붙어 있었습니다.
  //
  //   돌아가신 분께 안부 전화를 걸라고 적는 문서가 행정복지센터로 나가면, 그 한 줄이
  //   기관의 신뢰를 깎습니다. 유족이 보게 될 수도 있습니다.
  const memberState = getMemberState(resident, toDateStr(clampedAt));
  if (memberState.status === "종료") {
    sentences.push(
      memberState.reopenCandidate
        ? `종합적으로 ${memberState.reason}`
        : `종합적으로 ${memberState.reason}으로 확인 대상에서 빠진 분입니다. 급식 출결로는 더 보지 않습니다.`,
    );
  } else {
    sentences.push(`종합적으로 ${RISK_RECOMMENDATION[shownLevel]}`);
  }

  return {
    level,
    levelBeforeSnooze: classification.levelBeforeSnooze,
    attendanceRate: stats.rate,
    baselineRate,
    habitRate,
    recentRate,
    rateDeviation,
    consecutiveAbsence,
    typicalAbsenceStreak: Math.round(typicalAbsenceStreak * 10) / 10,
    streakDeviation,
    patternBreak,
    isRegularUser,
    isLongAbsent,
    eventOnlyVisits,
    reasons,
    narrative: sentences.join(" "),
  };
}

export function getCurrentRisk(
  resident: Resident,
  at: Date = TODAY_DATE,
): { level: RiskLevel; rate: number } {
  const assessment = getAiRiskAssessment(resident, at);
  // 가려지기 전 등급을 돌려줍니다. 이 함수를 쓰는 곳은 「이 어르신이 지금 몇 등급인가」를
  // 묻는 화면(명단·회원관리·월별 추이)이라, 안심 처리로 normal 이 된 분을 「정상」이라
  // 적으면 카드 숫자와 명단이 어긋납니다.
  return {
    level: assessment.levelBeforeSnooze ?? assessment.level,
    rate: assessment.attendanceRate,
  };
}

/**
 * 최근 3개월 등급 추이.
 *
 * 지금 "위기"라는 것만으로는 담당자가 판단을 못 합니다. 원래 계속 관리하던 분인지, 이번 달에
 * 갑자기 무너지신 분인지에 따라 해야 할 일이 완전히 다릅니다 —
 *
 *   관심 → 주의 → 위기   석 달에 걸쳐 나빠지는 중. 개입이 늦었다는 뜻입니다.
 *   양호 → 양호 → 위기   지난달까지 멀쩡하셨습니다. 이번 달에 무슨 일이 있었습니다.
 *   위기 → 위기 → 위기   오래된 상태. 지금까지 한 방식이 안 듣고 있다는 뜻입니다.
 *
 * 각 달의 마지막 운영일을 기준으로 그때 시점의 판단을 다시 계산합니다. 지금 자료로 과거를
 * 되돌아보는 것이라, 그 달에 실제로 화면에 그렇게 떴다는 뜻은 아닙니다.
 */
export function getRiskTrend(
  resident: Resident,
  months = 3,
  asOf: Date = DATA_END_DATE,
): { month: string; level: RiskLevel; rate: number }[] {
  const out: { month: string; level: RiskLevel; rate: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(asOf.getFullYear(), asOf.getMonth() - i + 1, 0);
    const at = d > asOf ? asOf : d;
    if (at < DATA_START) continue;
    const a = getAiRiskAssessment(resident, at);
    out.push({
      month: `${at.getMonth() + 1}월`,
      level: a.level,
      rate: a.attendanceRate,
    });
  }
  return out;
}

// 표 등에서 한 줄로 보여줄 수 있는 짧은 AI 진단 요약.
export function getAiOneLiner(resident: Resident, at: Date = TODAY_DATE): string {
  const a = getAiRiskAssessment(resident, at);
  const label = RISK_LABELS[a.level];
  if (a.patternBreak) {
    const detail =
      a.rateDeviation >= 15
        ? `평소 ${a.baselineRate}% → 최근 ${a.recentRate}%로 급락`
        : `연속결석 ${a.consecutiveAbsence}일로 평소 패턴 초과`;
    return `${label} · 평소와 다른 변화 (${detail})`;
  }
  if (a.consecutiveAbsence > 0) {
    return `${label} · 연속결석 ${a.consecutiveAbsence}일, 출석률 ${a.attendanceRate}%`;
  }
  if (a.level === "normal") {
    return `${label} · 출석률 ${a.attendanceRate}%로 양호`;
  }
  return `${label} · 출석률 ${a.attendanceRate}%, 추가 확인 필요`;
}

export function getRecentAttendance(resident: Resident, days = 7): boolean[] {
  const result: boolean[] = [];
  let cursor = addDays(DATA_END_DATE, -(days - 1));
  for (let i = 0; i < days; i++) {
    result.push(!!resident.attendance[toDateStr(cursor)]);
    cursor = addDays(cursor, 1);
  }
  return result;
}

export interface RiskKeyword {
  text: string;
  tone: "danger" | "warn" | "neutral" | "positive";
}

// 대시보드 목록에서는 긴 서술형 코멘트를 그대로 두면 훑어보기가 어렵습니다.
// 급한 순서대로 핵심 신호만 짧게 뽑아주고, 판단 근거 전문은 개인 상세 화면에서 봅니다.
export function getRiskKeywords(assessment: AiRiskAssessment, limit = 2): RiskKeyword[] {
  const a = assessment;
  const all: RiskKeyword[] = [];

  if (a.streakDeviation >= 3) {
    all.push({
      text: `연속결석 ${a.consecutiveAbsence}일 (평소 ${Math.round(a.typicalAbsenceStreak)}일)`,
      tone: "danger",
    });
  } else if (a.consecutiveAbsence > 0) {
    all.push({ text: `연속결석 ${a.consecutiveAbsence}일`, tone: "warn" });
  }

  if (a.rateDeviation >= 15) {
    all.push({
      text: `출석률 급락 ${a.baselineRate}% → ${a.recentRate}%`,
      tone: "danger",
    });
  }

  // 위 신호가 하나도 안 걸렸다면 왜 목록에 올라왔는지 알 수 있게 출석률을 보여줍니다.
  if (all.length === 0) {
    all.push({ text: `출석률 ${a.attendanceRate}%`, tone: "neutral" });
  }

  return all.slice(0, limit);
}

/**
 * 마지막으로 오신 날.
 *
 * ★ `asOfStr` **그 시점까지만** 봅니다. 예전에는 언제나 자료 마지막 날부터 거슬러
 *   올라가, 과거를 조회해도 미래의 방문을 집어 왔습니다 —
 *
 *     2026-01-30 마지막 방문 → 결석 → 2026-07-01 복귀하신 분
 *     리포트에서 **3월**을 고르면
 *       연속결석 42일        (3/31 기준 — 맞음)
 *       최근 출석일 08-28    ← 조회 시점보다 다섯 달 **미래**
 *
 *   한 줄 안에서 날짜가 모순되면 담당자는 그 줄만 버리는 게 아니라 목록 전체를
 *   안 믿게 됩니다. 그리고 과거 리포트로 소급 점검하는 일 자체가 불가능해집니다.
 *
 *   같은 파일의 getUnanalyzable 은 이미 `d <= asOfStr` 로 거르고 있었습니다 —
 *   설계 의도가 아니라 이 함수만 빠뜨린 것입니다.
 */
export function getLastAttendanceDate(
  resident: Resident,
  asOfStr: string = DATA_END_STR,
  opts: { skipCrowdDays?: boolean } = {},
): string | null {
  asOfStr = clampAsOf(asOfStr);
  let cursor = new Date(DATA_END_DATE);
  while (cursor >= DATA_START) {
    const dateStr = toDateStr(cursor);
    if (dateStr <= asOfStr && resident.attendance[dateStr]) {
      // 사람이 몰린 행사일(초복 등)을 복귀로 셀지. 연속결석·관측등급 계산은 안 세므로,
      // 그 숫자와 나란히 놓이는 자리에서는 여기도 안 세야 말이 맞습니다.
      if (opts.skipCrowdDays && CROWD_DAYS.has(dateStr)) {
        cursor = addDays(cursor, -1);
        continue;
      }
      return dateStr;
    }
    cursor = addDays(cursor, -1);
  }
  return null;
}

/** 이 어르신의 가장 이른 출석 기록일. 없으면 등록일. 개인 달력·이력의 시작점으로 씁니다. */
export function getFirstAttendanceDate(resident: Resident): string {
  let earliest: string | null = null;
  for (const d of Object.keys(resident.attendance)) {
    if (earliest === null || d < earliest) earliest = d;
  }
  return earliest ?? resident.registeredAt;
}

/**
 * 선택한 날짜 시점까지 "등록된" 활동 어르신 수.
 *
 * 상단 모수(총원)는 고정이 아니라 그 달 시점에 실제로 등록돼 있던 인원이어야 합니다.
 * 2025년에는 아직 등록 전인 분이 많아 총원이 396명보다 적습니다.
 */
export function getRegisteredCountAsOf(asOfStr: string): number {
  const clamped = asOfStr > DATA_END_STR ? DATA_END_STR : asOfStr;
  let n = 0;
  for (const r of getActiveResidents()) if (r.registeredAt <= clamped) n++;
  return n;
}

/** 자료 구간(DATA_START~DATA_END) 안의 월 목록. 화면의 달 선택기에서 공용으로 씁니다. */
export function getMonthOptions(): { year: number; month: number; label: string }[] {
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

// ── 대시보드 달력 위젯 (기관 전체) ──────────────────────────────

export interface OrgCalendarDay {
  date: string;
  day: number;
  presentCount: number;
  totalCount: number;
  rate: number;
  status: "many" | "normal" | "few" | "none";
}

export function getCalendarMonth(
  year: number,
  month: number,
): { year: number; month: number; days: OrgCalendarDay[] } {
  const active = getActiveResidents();
  const daysInMonth = new Date(year, month, 0).getDate();
  const raw: {
    date: string;
    day: number;
    presentCount: number;
    totalCount: number;
    rate: number;
    hasData: boolean;
  }[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
    const d = parseDateStr(dateStr);
    // 운영일 목록에 있는 날만 "자료 있는 날"입니다. 예전에는 주말만 걸러서,
    // 공휴일·휴관일·아직 안 넣은 날이 모두 "출석 0명"으로 나왔습니다 —
    // 2025년 12월(휴관)을 열면 어르신 전원이 결석자로 나열됐습니다.
    const hasData = OPERATING_DAY_SET.has(toDateStr(d));
    let presentCount = 0;
    if (hasData) {
      for (const r of active) if (r.attendance[dateStr]) presentCount++;
    }
    const totalCount = active.length;
    const rate = hasData ? Math.round((presentCount / totalCount) * 1000) / 10 : 0;
    raw.push({ date: dateStr, day, presentCount, totalCount, rate, hasData });
  }
  const withData = raw.filter((d) => d.hasData);
  const avgRate = withData.length ? withData.reduce((s, d) => s + d.rate, 0) / withData.length : 0;
  const days: OrgCalendarDay[] = raw.map((d) => {
    let status: OrgCalendarDay["status"] = "none";
    if (d.hasData) {
      if (d.rate >= avgRate + 5) status = "many";
      else if (d.rate <= avgRate - 15) status = "few";
      else status = "normal";
    }
    return {
      date: d.date,
      day: d.day,
      presentCount: d.presentCount,
      totalCount: d.totalCount,
      rate: d.rate,
      status,
    };
  });
  return { year, month, days };
}

/**
 * 하루치 상세.
 *
 * menu 항목이 있었지만 없앴습니다. 날짜를 해시해서 미리 정해둔 열 개의 식단 중 하나를
 * 골라주는 값이었고(= 지어낸 값), 화면 어디에도 표시되지 않는 죽은 코드였습니다. 나중에
 * 누군가 "식단 자료가 있네" 하고 화면에 꺼내 쓰면 실제와 다른 식단이 기록으로 남게 됩니다.
 *
 * 설계근거 문서 3.3의 메뉴 선호도 변수는 근거가 가장 탄탄한 변수 중 하나지만(해외 실증),
 * 실제 식단표가 들어와야 만들 수 있습니다. 문서 6장도 "식단표가 디지털로 남아 있는지"를
 * 확인 대상으로 두고 있습니다. 자료가 확인되면 menus 표를 만들어 여기 붙이면 됩니다.
 */
export interface DayDetail {
  date: string;
  hasData: boolean;
  presentCount: number;
  absentCount: number;
  rate: number;
  weather: string;
  /** 그날 식단. 자료가 없으면 null — 지어낸 값을 넣지 않습니다. */
  menu: ReturnType<typeof getMenu>;
  /**
   * 그날 결석이 많았을 만한 사정. 위험도 계산에는 쓰이지 않고 설명으로만 붙습니다.
   * 비어 있다는 것 자체가 중요한 정보입니다 — 아무 사정도 없는데 안 오셨다는 뜻입니다.
   */
  referenceFactors: ReferenceFactor[];
  present: { id: string; name: string }[];
  absent: { id: string; name: string }[];
}

export function getDayDetail(dateStr: string): DayDetail {
  const active = getActiveResidents();
  const d = parseDateStr(dateStr);
  // 운영일 목록에 있는 날만 "자료 있는 날"입니다. 예전에는 주말만 걸러서,
  // 공휴일·휴관일·아직 안 넣은 날이 모두 "출석 0명"으로 나왔습니다 —
  // 2025년 12월(휴관)을 열면 어르신 전원이 결석자로 나열됐습니다.
  const hasData = OPERATING_DAY_SET.has(toDateStr(d));
  const present: { id: string; name: string }[] = [];
  const absent: { id: string; name: string }[] = [];
  if (hasData) {
    for (const r of active) {
      if (r.attendance[dateStr]) present.push({ id: r.id, name: r.name });
      else absent.push({ id: r.id, name: r.name });
    }
  }
  // 실제 춘천 기상 자료입니다. 아직 받아오지 못했거나 해당 날짜 자료가 없으면 빈 값으로 둡니다 —
  // 지어낸 날씨를 넣으면 그날 날씨를 확인해 본 사람에게 앞뒤가 맞지 않는 자료가 됩니다.
  const dayWeather = getWeather(dateStr);
  const weather = dayWeather ? describeWeather(dayWeather) : "";
  return {
    date: dateStr,
    hasData,
    presentCount: present.length,
    absentCount: absent.length,
    rate: hasData ? Math.round((present.length / active.length) * 1000) / 10 : 0,
    weather,
    menu: getMenu(dateStr),
    referenceFactors: hasData ? getReferenceFactors(dateStr) : [],
    present,
    absent,
  };
}

export interface AttendanceShift {
  date: string;
  count: number;
  /** 그 달 평균과 요일 버릇까지 감안한 "이 정도는 왔어야 할" 인원 */
  expected: number;
  /** 예상 대비 몇 %인지. +92면 두 배쯤 오신 것입니다. */
  deltaPct: number;
  direction: "surge" | "drop";
  /** 그날 붙는 사정들. 비어 있으면 설명되지 않는 변화입니다. */
  reasons: string[];
}

/**
 * 사람이 갑자기 늘거나 줄어든 날을 찾아냅니다.
 *
 * 단순히 "평균보다 적은 날"로 찾으면 안 됩니다. 이 기관은 3월 260명에서 7월 431명까지
 * 이용자 자체가 계속 늘었고, 요일 버릇도 뚜렷합니다(월요일 +5%, 금요일 -5%). 그래서
 * 전체 평균과 비교하면 봄이 전부 "급감"으로, 여름이 전부 "급증"으로 잡힙니다.
 *
 * 그 달 평균과 요일 보정을 함께 적용한 "이 정도는 왔어야 할 인원"과 비교합니다.
 *
 * 왜 필요한가: 하루 400명이 오는 곳에서 개인의 결석은 묻힙니다. 그런데 어느 날 100명이
 * 덜 왔다면 그건 개인 사정이 아니라 그날 무슨 일이 있었던 것이고, 그 사정을 모르면 그날
 * 결석한 100명이 전부 개인 책임으로 잡힙니다. 반대로 갑자기 몰린 날은 그날 **안 오신 분**이
 * 가장 강한 신호입니다 — 다들 오는 날에 안 오셨다는 뜻이니까요.
 */
export function getAttendanceShifts(thresholdPct = 15): AttendanceShift[] {
  const active = getActiveResidents();
  if (!active.length || OPERATING_DAYS.length < 10) return [];

  // 분석에서 뺀 날(밀키트·오류일·일괄발권)은 여기서도 빼야 합니다.
  //
  // 안 빼면 이런 것이 "갑자기 줄어든 날" 맨 위에 올라옵니다 —
  //   2026-03-12 (목)  1명 · 예상 76명 대비 −98.7%   ← 자료가 덜 들어온 오류일
  //   2025-06-22 (일)  2명 · 예상 86명 대비 −97.7%   ← 일요일, 문 여는 날이 아님
  // 담당자가 확인해 봐야 아무 일도 없었던 날입니다. 이런 것이 목록 위를 채우면 정작 봐야 할
  // 날이 아래로 밀리고, 몇 번 헛걸음하면 목록 전체를 안 봅니다.
  //
  // 다른 계산은 전부 REDUCED_OPERATION 으로 거르는데 이 함수만 빠져 있었습니다.
  const days = OPERATING_DAYS.filter((d) => !REDUCED_OPERATION.has(d));
  if (days.length < 10) return [];

  const count = new Map<string, number>();
  for (const d of days) {
    let n = 0;
    for (const r of active) if (r.attendance[d]) n++;
    count.set(d, n);
  }

  // 기준선은 **그 날 앞뒤 운영일의 중앙값**으로 잡습니다.
  //
  // 처음에는 그 달 평균을 썼는데 3월이 통째로 틀렸습니다. 3월은 앞부분이 리모델링 휴관 중
  // 도시락 배부(금요일만, 85명쯤)이고 16일부터 재개관(주 5일, 300명쯤)이라, 한 달로 묶어
  // 평균을 내면 217명이 나옵니다. 그러면 도시락 날은 전부 "급감", 재개관 후는 전부 "급증"이
  // 됩니다 — 실제로 03-13이 -61.8%로 "짚이는 사정이 없다"고 떴는데, 그날은 그냥 도시락
  // 배부일이었습니다.
  //
  // 앞뒤 운영일만 보면 이런 급변을 자연스럽게 넘어갑니다. 평균이 아니라 중앙값을 쓰는 이유도
  // 같습니다 — 무료급식 행사 828명 같은 하루가 주변 기준선을 통째로 끌어올리면, 그 앞뒤
  // 평범한 날들이 "급감"으로 잡힙니다.
  const WINDOW = 7; // 앞뒤로 각각 7 운영일 = 대략 3주
  const median = (xs: number[]) => {
    const a = [...xs].sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };
  const baseline = new Map<string, number>();
  for (let i = 0; i < days.length; i++) {
    const near: number[] = [];
    for (let j = Math.max(0, i - WINDOW); j <= Math.min(days.length - 1, i + WINDOW); j++) {
      if (j === i) continue;
      near.push(count.get(days[j]) ?? 0);
    }
    if (near.length >= 6) baseline.set(days[i], median(near));
  }

  // 요일 보정계수 — 주변 기준선 대비 비율의 중앙값입니다.
  const wdRatios = new Map<number, number[]>();
  for (const [d, n] of count) {
    const b = baseline.get(d) ?? 0;
    if (b <= 0) continue;
    const wd = parseDateStr(d).getDay();
    if (!wdRatios.has(wd)) wdRatios.set(wd, []);
    wdRatios.get(wd)!.push(n / b);
  }
  const wdFactor = new Map<number, number>();
  for (const [wd, list] of wdRatios) {
    if (list.length >= 5) wdFactor.set(wd, median(list));
  }

  const out: AttendanceShift[] = [];
  for (const d of days) {
    const n = count.get(d) ?? 0;
    const b = baseline.get(d);
    // 자료 맨 앞뒤는 주변 운영일이 모자라 기준선을 못 만듭니다. 억지로 만들면 첫날과
    // 마지막 날이 늘 이상한 날로 잡힙니다.
    if (b === undefined || b <= 0) continue;
    const f = wdFactor.get(parseDateStr(d).getDay()) ?? 1;
    const expected = b * f;
    if (expected <= 0) continue;
    const deltaPct = Math.round((n / expected - 1) * 1000) / 10;
    if (Math.abs(deltaPct) < thresholdPct) continue;

    const reasons: string[] = [];

    // 운영 방식이 바뀐 시기인지 먼저 봅니다.
    //
    // 2026년 1~3월 중순은 리모델링 휴관 중이라 금요일에 도시락만 배부했습니다(주 1회, 85명쯤).
    // 3월 16일 재개관 후에는 주 5일에 300명이 넘습니다. 이 경계에서는 인원이 두 배로 뛰거나
    // 반토막이 나는데, 그건 어르신들 사정이 아니라 기관이 문을 여는 방식이 바뀐 것입니다.
    // 이걸 "짚이는 사정이 없다"고 적으면 담당자가 있지도 않은 원인을 찾게 됩니다.
    //
    // 라벨을 따로 관리하지 않고 자료에서 알아냅니다 — 앞 2주와 뒤 2주의 운영일 수를 비교해
    // 크게 달라졌으면 경계로 봅니다.
    const idx = OPERATING_DAYS.indexOf(d);
    const near2w = (from: number, to: number) =>
      OPERATING_DAYS.slice(Math.max(0, from), Math.min(days.length, to)).length;
    const before = near2w(idx - 10, idx);
    const after = near2w(idx + 1, idx + 11);
    const cur = parseDateStr(d);
    const spanDays = (a: number, b: number) => {
      const xs = OPERATING_DAYS.slice(Math.max(0, a), Math.min(days.length, b));
      if (xs.length < 2) return 0;
      return (
        (parseDateStr(xs[xs.length - 1]).getTime() - parseDateStr(xs[0]).getTime()) / 86400000 + 1
      );
    };
    const beforeRate = spanDays(idx - 10, idx) ? before / spanDays(idx - 10, idx) : 0;
    const afterRate = spanDays(idx + 1, idx + 11) ? after / spanDays(idx + 1, idx + 11) : 0;
    if (
      beforeRate > 0 &&
      afterRate > 0 &&
      (afterRate / beforeRate >= 2 || beforeRate / afterRate >= 2)
    ) {
      reasons.push(
        afterRate > beforeRate
          ? "이 무렵부터 문을 여는 날이 크게 늘었습니다 (휴관·도시락 배부 → 정상 운영)"
          : "이 무렵부터 문을 여는 날이 크게 줄었습니다 (정상 운영 → 휴관·도시락 배부)",
      );
    }
    void cur;

    // 식단표에 적힌 행사. 휴관으로 표시된 날도 그 사유를 그대로 적습니다 — 왜 그랬는지
    // 알아보는 화면이라 감추면 안 됩니다.
    const ev = getMenuNote(d);
    if (ev) reasons.push(ev);
    const holiday = HOLIDAY_LABELS.get(d);
    if (holiday) reasons.push(holiday);
    // 그날 해당하는 사정을 적되, **검정에서 무효로 나온 변수는 빼야 합니다.**
    //
    // 예전에는 detectReferenceFactors 를 그대로 썼습니다. "왜 그랬는지 알아보는 화면이니
    // 다 보여주자"는 뜻이었는데, 실제로는 이렇게 나왔습니다 —
    //   2025-06-22 (일) 2명 · 예상 86명 대비 −97.7%  →  "장날 (풍물시장 2·7일장)"
    // 일요일에 두 명만 기록된 자료 오류인데 장날 탓이라고 적힌 것입니다. 무효인 변수를
    // 근거처럼 붙이면 담당자가 "아, 장날이라 그랬구나" 하고 넘어갑니다 — 우리가 막으려던
    // 바로 그 일입니다.
    const EXPLAINS: ReferenceFactorKind[] = ["badWeather", "holidayAdjacent"];
    for (const f2 of detectReferenceFactors(d)) {
      if (f2.kind === "special") continue; // 위에서 행사명으로 이미 적었습니다
      if (!EXPLAINS.includes(f2.kind)) continue;
      reasons.push(f2.label);
    }

    out.push({
      date: d,
      count: n,
      expected: Math.round(expected),
      deltaPct,
      direction: deltaPct > 0 ? "surge" : "drop",
      reasons,
    });
  }
  return out.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
}

export interface ExternalFactorEntry {
  date: string;
  label: string;
  type: "holiday" | "weather";
}

export function getExternalFactorSummary(): ExternalFactorEntry[] {
  const entries: ExternalFactorEntry[] = [];
  for (const [date, label] of HOLIDAY_LABELS.entries()) {
    entries.push({ date, label, type: "holiday" });
  }
  // 참고 요인으로 뺀 날은 여기 넣지 않습니다 — 아래 ② 구역에서 스위치와 함께 보여줍니다.
  for (const date of ANOMALY_DATES) {
    if (HOLIDAY_LABELS.has(date)) continue;
    // 날씨는 그날 결석이 많았던 "이유 후보"로만 붙입니다. 자료가 없으면 이유 없이 사실만 적습니다.
    const w = getWeather(date);
    entries.push({
      date,
      label: w ? `기관 전체 결석 급증 · ${describeWeather(w)}` : "기관 전체 결석 급증",
      type: "weather",
    });
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

// ── 참고 외부변수 ───────────────────────────────────────────
//
// 공휴일과 달리 위험도 계산에서 빼지 않는 변수들입니다. 자세한 이유는 external-factors.ts
// 머리말에 적어두었습니다 — 요약하면 장날만 매달 6일이라 다 빼면 자료가 남지 않고, 하필
// 장날부터 안 나오기 시작한 어르신이 가려집니다.

export interface ReferenceFactorDay {
  date: string;
  factors: ReferenceFactor[];
}

/** 해당 달 운영일에 붙은 참고 요인 목록. 요인이 없는 날은 빠집니다. */
export function getReferenceFactorsForMonth(year: number, month: number): ReferenceFactorDay[] {
  const out: ReferenceFactorDay[] = [];
  const lastDay = new Date(year, month, 0).getDate();
  for (let day = 1; day <= lastDay; day++) {
    const d = new Date(year, month - 1, day);
    if (d < DATA_START || d > DATA_END_DATE) continue;
    if (isWeekend(d)) continue;
    const dateStr = toDateStr(d);
    if (HOLIDAY_LABELS.has(dateStr)) continue; // 문 닫은 날은 볼 필요가 없습니다
    const factors = getReferenceFactors(dateStr);
    if (factors.length) out.push({ date: dateStr, factors });
  }
  return out;
}

// ── 행사일 결석 — 가장 강한 신호 ────────────────────────────
//
// 다른 외부변수는 "덜 오실 만한 사정"이라 결석을 봐줄 근거가 됩니다. 특식·행사는 반대입니다.
// 평소 396명 오시는 곳에 828명이 오신 날, 안 오신 분은 **평소 잘 안 오시던 분도 오시는 날에
// 못 나오신 것**입니다. 그날 결석은 가장 조사할 가치가 큽니다.
//
// 지금 대시보드는 이걸 전혀 구분하지 못합니다 — 비 오는 날 결석과 초복 삼계탕 날 결석을
// 똑같이 셉니다. 그 둘은 전혀 다른 의미입니다.

export interface SpecialDayAbsence {
  date: string;
  eventLabel: string;
  /** 그날 출석률(%) */
  dayRate: number;
  /** 같은 달 다른 운영일들의 출석률 중앙값(%) */
  monthTypicalRate: number;
  /** dayRate / monthTypicalRate. 1.10 이상이면 실제로 사람이 몰린 날입니다. */
  lift: number;
  /** 실제로 사람이 몰린 행사였는가. 이 값이 false면 결석을 강한 신호로 보면 안 됩니다. */
  drewCrowd: boolean;
  absentees: Resident[];
}

// 행사 라벨이 붙었어도 실제로 사람이 몰렸는지는 달랐습니다. 실제 출결 자료로 확인한 값:
//
//   2026-04-27  무료 특식 데이   700명 / 중앙 303  →  2.31배
//   2026-07-08  무료급식 행사    828명 / 중앙 395  →  2.10배
//   2026-07-15  초복            752명 / 중앙 395  →  1.90배
//   2026-05-08  어버이날        427명 / 중앙 352  →  1.21배
//   2026-08-14  말복            385명 / 중앙 421  →  0.91배  ← 오히려 적었습니다
//
// 초복은 1.90배인데 말복은 0.91배입니다. 같은 복날인데 정반대입니다. 그래서 행사 라벨만
// 보고 "이날 결석은 강한 신호"라고 하면 말복 날에 오탐이 쏟아집니다.
//
// 1.10 배로 잡은 이유: 위 자료에서 실제로 몰린 날(1.90~2.31배)과 그렇지 않은 날(0.91배)
// 사이가 넓게 벌어져 있어, 그 사이 어디로 잡아도 판정이 같습니다. 어버이날(1.21배)만
// 경계에 걸리는데, 그날은 실제로 그 달 최고 출석일이었으므로 포함되는 쪽이 맞습니다.
const SPECIAL_DAY_LIFT = 1.1;

/**
 * 선택한 달의 행사일별 결석자 목록.
 *
 * 행사일 판정은 식단표(menus 표)에서만 읽습니다. 출석이 급증한 날을 행사로 되짚으면
 * 순환논리가 됩니다 — 출석으로 행사를 정하고 그 행사로 출석을 설명하는 셈이 됩니다.
 *
 * 출석은 그 뒤에, "이 행사가 실제로 사람을 모았는가"를 확인하는 데만 씁니다. 이건 순환이
 * 아닙니다 — 행사 여부는 여전히 식단표가 정하고, 출석은 그 행사의 효과만 재는 것입니다.
 */
export function getSpecialDayAbsences(year: number, month: number): SpecialDayAbsence[] {
  const active = getActiveResidents();
  if (!active.length) return [];

  // 먼저 그 달 운영일별 출석률을 모두 구합니다(중앙값 비교용).
  const rates = new Map<string, number>();
  const lastDay = new Date(year, month, 0).getDate();
  const eventDates: { date: string; label: string }[] = [];

  for (let day = 1; day <= lastDay; day++) {
    const d = new Date(year, month - 1, day);
    if (d < DATA_START || d > DATA_END_DATE) continue;
    if (isWeekend(d)) continue;
    const dateStr = toDateStr(d);
    if (HOLIDAY_LABELS.has(dateStr)) continue;

    // 운영일이 아니면(휴관·자료 미반영) 셈에서 뺍니다. "그날 아무도 안 왔다"가 아니라
    // "그날은 애초에 기회가 아니었다"입니다.
    if (!OPERATING_DAY_SET.has(dateStr)) continue;

    // ── 결석은 기록이 없습니다 ──────────────────────────────
    // 자료에는 **오신 날만** 들어옵니다(엔컴 가져오기·CSV 둘 다). 그래서 예전처럼
    // `attendance[날짜] === undefined`를 "안 센다"로 처리하면 결석이 한 건도 남지
    // 않아 모든 날의 출석률이 100%가 됩니다. 그러면 몰림 배수가 언제나 1.00배로
    // 나와 이 기능이 통째로 죽습니다(실제로 그랬습니다).
    //
    // 분모는 "그날 오실 수 있었던 분"입니다 — 등록 전인 분은 빼야 없는 결석을
    // 만들지 않습니다.
    let present = 0;
    let counted = 0;
    for (const r of active) {
      if (r.registeredAt > dateStr) continue;
      counted++;
      if (r.attendance[dateStr]) present++;
    }
    if (!counted) continue;
    rates.set(dateStr, (present / counted) * 100);

    // 특식·행사 변수를 꺼두면 이 카드도 나오지 않아야 합니다. 스위치를 껐는데 화면
    // 어딘가에 그대로 남아 있으면 스위치를 믿을 수 없게 됩니다.
    const menu = isFactorEnabled("special") ? getMenu(dateStr) : null;
    if (menu && !menu.closed && menu.eventLabel) {
      eventDates.push({ date: dateStr, label: menu.eventLabel });
    }
  }
  if (!eventDates.length) return [];

  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const v = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  const round1 = (n: number) => Math.round(n * 10) / 10;

  return eventDates.map(({ date, label }) => {
    const dayRate = rates.get(date) ?? 0;
    // 비교 대상에서 그날 자신은 뺍니다. 넣으면 자기가 자기 기준을 끌어올립니다.
    const others = [...rates.entries()].filter(([k]) => k !== date).map(([, v]) => v);
    const typical = median(others);
    const lift = typical > 0 ? dayRate / typical : 0;

    // 결석자 = 그날 오실 수 있었는데 기록이 없는 분.
    //
    // 다만 **평소 오시던 분만** 셉니다. 명부 전체를 놓고 세면 258명이 나옵니다 — 원래
    // 한 달에 한두 번 오시는 분이 행사에 안 오신 것은 아무 신호가 아닌데, 그런 분이 목록을
    // 가득 채우면 정작 봐야 할 몇 분이 묻힙니다. 이 카드의 쓸모는 "늘 오시던 분이 하필
    // 오늘 안 오셨다"이고, 기준은 위험도 판정에서 쓰는 것과 같은 값을 씁니다.
    const regularMin = getRegularUserMinRate();
    const absentees: Resident[] = [];
    for (const r of active) {
      if (r.registeredAt > date) continue;
      if (r.attendance[date]) continue;
      const opp = opportunityDays(r, r.registeredAt, date);
      if (opp.length < 20) continue; // 자료가 얕으면 "평소"를 말할 수 없습니다
      let came = 0;
      for (const d of opp) if (r.attendance[d]) came++;
      if ((came / opp.length) * 100 < regularMin) continue;
      absentees.push(r);
    }

    return {
      date,
      eventLabel: label,
      dayRate: round1(dayRate),
      monthTypicalRate: round1(typical),
      lift: Math.round(lift * 100) / 100,
      drewCrowd: lift >= SPECIAL_DAY_LIFT,
      absentees,
    };
  });
}

// 이 달에 각 변수가 며칠에 해당하는지 — **켜기/끄기와 무관하게** 셉니다.
//
// 화면에서 "이 스위치를 끄면 무엇이 달라지는지"를 미리 보여주기 위한 값입니다. 꺼진 변수도
// 세어야 "켜면 3일에 표시됩니다"라고 말할 수 있습니다.
export function getMonthFactorCounts(
  year: number,
  month: number,
): Record<ReferenceFactorKind, number> {
  const counts: Record<ReferenceFactorKind, number> = {
    special: 0,
    badWeather: 0,
    market: 0,
    holidayAdjacent: 0,
    pension: 0,
  };
  const lastDay = new Date(year, month, 0).getDate();
  for (let day = 1; day <= lastDay; day++) {
    const d = new Date(year, month - 1, day);
    if (d < DATA_START || d > DATA_END_DATE) continue;
    if (isWeekend(d)) continue;
    const dateStr = toDateStr(d);
    if (HOLIDAY_LABELS.has(dateStr)) continue;
    for (const f of detectReferenceFactors(dateStr)) counts[f.kind] += 1;
  }
  return counts;
}

export interface FactorImpact {
  kind: ReferenceFactorKind;
  name: string;
  /** 근거의 성격. "검증된 사실"과 "확인 중인 가설"을 화면에서 구분하기 위한 값입니다. */
  evidence: string;
  color: string;
  daysWith: number;
  daysWithout: number;
  /** 해당 요인이 있던 날들의 평균 출석률(%) */
  rateWith: number;
  rateWithout: number;
  /** rateWith - rateWithout. 음수면 그 요인이 있는 날 덜 오셨다는 뜻입니다. */
  diff: number;
}

/**
 * 참고 변수가 실제로 출석률과 관계가 있는지 우리 자료로 확인합니다.
 *
 * 설계근거 문서가 장날·명절 전후·기초연금을 모두 "자체 검증 필요"로 분류한 이유가 이것입니다.
 * 장날 효과를 직접 검증한 선행연구가 없으므로, 여기서 차이가 확인되면 그 자체가 이 프로젝트의
 * 발견이 됩니다. 반대로 차이가 없으면 변수에서 빼면 됩니다 — 근거 없는 변수를 남겨두면
 * "장날이라 안 오셨겠지"로 진짜 신호를 넘겨버립니다.
 *
 * 계산 대상은 운영일(평일·공휴일 제외)뿐입니다. 요일 효과는 통제하지 않았습니다 — 장날은
 * 2·7일 고정이라 요일이 매달 돌아가므로 24개월 정도 쌓이면 자연히 섞입니다. 표본이 짧을 때는
 * 이 수치를 결론이 아니라 참고로만 봐야 합니다.
 */
export interface MenuInsight {
  key: string;
  label: string;
  days: number;
  /** 그 재료가 나온 날 평균 출석 편차(월·요일 통제) %, 그 외 대비 차이 */
  diffPct: number;
  spreadPct: number;
  /** 흩어짐보다 큰 차이인가 — 참일 때만 "신호"로 봅니다 */
  meaningful: boolean;
}

// 메뉴 재료 사전. 화면에서 "무엇으로 묶어 봤는지" 그대로 보여줄 수 있게 코드에 둡니다.
const MENU_KEYWORDS: { key: string; label: string; words: string[] }[] = [
  {
    key: "beef",
    label: "소고기·갈비",
    words: ["소고기", "쇠고기", "불고기", "우육", "장조림", "갈비", "떡국"],
  },
  {
    key: "pork",
    label: "돼지고기",
    words: ["돈육", "제육", "돼지", "수육", "두루치기", "돈까스", "탕수육", "보쌈"],
  },
  { key: "chicken", label: "닭고기", words: ["닭", "치킨", "삼계", "찜닭", "볶음탕"] },
  {
    key: "fish",
    label: "생선·해물",
    words: [
      "갈치",
      "고등어",
      "가자미",
      "임연수",
      "조기",
      "삼치",
      "생선",
      "오징어",
      "새우",
      "해물",
      "낙지",
      "골뱅이",
    ],
  },
  { key: "noodle", label: "면·짜장", words: ["국수", "면", "짜장", "짬뽕", "우동", "냉면"] },
];

/**
 * 메뉴가 출석을 움직이는가 — 우리 자료로 재서 정직하게 돌려줍니다.
 *
 * "고기 나온 날 사람이 더 오나"를 확인하는 자리입니다. 다만 **함부로 신호라고 말하지
 * 않습니다.** 그 달 평균과 요일 버릇을 걷어낸 편차로 재고, 날마다 흩어지는 정도(표준편차)와
 * 비교합니다. 차이가 흩어짐보다 클 때만 meaningful=true 로 둡니다.
 *
 * 2026년 자료(식단 있는 3~8월, 행사일 제외 약 100일)로는 어느 재료도 흩어짐을 넘지
 * 못했습니다 — 갈비가 +6.8%p로 제일 컸지만 흩어짐이 ±12였습니다. 그래서 화면은 "아직 뚜렷한
 * 영향이 확인되지 않았다"를 보여주고, 자료가 쌓이면 여기 숫자가 저절로 달라집니다.
 */
export function getMenuInsights(): { insights: MenuInsight[]; sampleDays: number } {
  const active = getActiveResidents();
  if (!active.length) return { insights: [], sampleDays: 0 };

  // 식단 있고, 운영일이고, 사람이 몰린 행사일이 아닌 날.
  const days = OPERATING_DAYS.filter(
    (d) => !!getMenu(d) && !CROWD_DAYS.has(d) && !REDUCED_OPERATION.has(d),
  );
  if (days.length < 20) return { insights: [], sampleDays: days.length };

  const count = new Map<string, number>();
  for (const d of days) {
    let n = 0;
    for (const r of active) if (r.attendance[d]) n++;
    count.set(d, n);
  }
  // 월·요일 통제 편차
  const monthAvg = new Map<string, number>();
  const byMonth = new Map<string, number[]>();
  for (const d of days) {
    const m = d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(count.get(d)!);
  }
  for (const [m, list] of byMonth) monthAvg.set(m, list.reduce((a, b) => a + b, 0) / list.length);
  const wd = (d: string) => parseDateStr(d).getDay();
  const wdRatio = new Map<number, number[]>();
  for (const d of days) {
    const avg = monthAvg.get(d.slice(0, 7))!;
    if (avg > 0) {
      if (!wdRatio.has(wd(d))) wdRatio.set(wd(d), []);
      wdRatio.get(wd(d))!.push(count.get(d)! / avg);
    }
  }
  const wdFactor = new Map<number, number>();
  for (const [k, list] of wdRatio) wdFactor.set(k, list.reduce((a, b) => a + b, 0) / list.length);
  const dev = (d: string) => {
    const base = monthAvg.get(d.slice(0, 7))! * (wdFactor.get(wd(d)) ?? 1);
    return base > 0 ? count.get(d)! / base - 1 : 0;
  };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const pstdev = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  };

  const insights: MenuInsight[] = [];
  for (const kw of MENU_KEYWORDS) {
    const withDays = days.filter((d) => kw.words.some((w) => getMenu(d)!.menu.includes(w)));
    const without = days.filter((d) => !kw.words.some((w) => getMenu(d)!.menu.includes(w)));
    if (withDays.length < 5) continue;
    const a = withDays.map(dev);
    const b = without.map(dev);
    const diff = (mean(a) - mean(b)) * 100;
    const spread = pstdev(a) * 100;
    insights.push({
      key: kw.key,
      label: kw.label,
      days: withDays.length,
      diffPct: Math.round(diff * 10) / 10,
      spreadPct: Math.round(spread),
      meaningful: Math.abs(diff) > spread && spread > 0,
    });
  }
  insights.sort((x, y) => y.diffPct - x.diffPct);
  return { insights, sampleDays: days.length };
}

// ── 날씨 임계값별 효과 ─────────────────────────────────────────
//
// "비 몇 mm 이상이면 실제로 덜 오시나?"를 임계값별로 나눠 봅니다. 메뉴와 똑같은 방식(그 달
// 평균·요일 버릇을 걷어낸 편차, ±편차와 비교)으로 재서, 차이가 편차보다 클 때만 "효과 있음"으로
// 표시합니다. 담당자가 "비 5mm냐 10mm냐"를 숫자로 보고 기준을 정할 수 있게 하는 자리입니다.
export interface WeatherThresholdImpact {
  key: string;
  label: string;
  days: number;
  diffPct: number; // 그 조건인 날 - 아닌 날 (월·요일 통제 편차, %p)
  spreadPct: number; // ±편차(표준편차)
  meaningful: boolean; // 차이가 편차보다 클 때만 효과 있음
}

export function getWeatherThresholdImpact(): {
  rows: WeatherThresholdImpact[];
  sampleDays: number;
} {
  const active = getActiveResidents();
  if (!active.length) return { rows: [], sampleDays: 0 };

  // 행사일·감축운영일을 빼고, 날씨 자료가 있는 운영일만 봅니다(메뉴 분석과 같은 기준).
  const days = OPERATING_DAYS.filter(
    (d) => !CROWD_DAYS.has(d) && !REDUCED_OPERATION.has(d) && !!getWeather(d),
  );
  if (days.length < 20) return { rows: [], sampleDays: days.length };

  const count = new Map<string, number>();
  for (const d of days) {
    let n = 0;
    for (const r of active) if (r.attendance[d]) n++;
    count.set(d, n);
  }
  // 월 평균 + 요일 계수로 통제한 편차(메뉴 분석과 동일).
  const byMonth = new Map<string, number[]>();
  for (const d of days) {
    const m = d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(count.get(d)!);
  }
  const monthAvg = new Map<string, number>();
  for (const [m, list] of byMonth) monthAvg.set(m, list.reduce((a, b) => a + b, 0) / list.length);
  const wd = (d: string) => parseDateStr(d).getDay();
  const wdRatio = new Map<number, number[]>();
  for (const d of days) {
    const avg = monthAvg.get(d.slice(0, 7))!;
    if (avg > 0) {
      if (!wdRatio.has(wd(d))) wdRatio.set(wd(d), []);
      wdRatio.get(wd(d))!.push(count.get(d)! / avg);
    }
  }
  const wdFactor = new Map<number, number>();
  for (const [k, list] of wdRatio) wdFactor.set(k, list.reduce((a, b) => a + b, 0) / list.length);
  const dev = (d: string) => {
    const base = monthAvg.get(d.slice(0, 7))! * (wdFactor.get(wd(d)) ?? 1);
    return base > 0 ? count.get(d)! / base - 1 : 0;
  };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const pstdev = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  };

  const THRESHOLDS: { key: string; label: string; test: (d: string) => boolean }[] = [
    { key: "rain5", label: "비 5mm 이상", test: (d) => (getWeather(d)?.precipitationMm ?? 0) >= 5 },
    {
      key: "rain10",
      label: "비 10mm 이상",
      test: (d) => (getWeather(d)?.precipitationMm ?? 0) >= 10,
    },
    {
      key: "rain20",
      label: "비 20mm 이상",
      test: (d) => (getWeather(d)?.precipitationMm ?? 0) >= 20,
    },
    { key: "heat33", label: "체감 33℃ 이상", test: (d) => (getWeather(d)?.apparentMax ?? 0) >= 33 },
    { key: "heat35", label: "체감 35℃ 이상", test: (d) => (getWeather(d)?.apparentMax ?? 0) >= 35 },
    { key: "snow", label: "눈 0.5cm 이상", test: (d) => (getWeather(d)?.snowfallCm ?? 0) >= 0.5 },
  ];

  const rows: WeatherThresholdImpact[] = [];
  for (const t of THRESHOLDS) {
    const withDays = days.filter(t.test);
    const without = days.filter((d) => !t.test(d));
    if (withDays.length < 3) {
      rows.push({
        key: t.key,
        label: t.label,
        days: withDays.length,
        diffPct: 0,
        spreadPct: 0,
        meaningful: false,
      });
      continue;
    }
    const a = withDays.map(dev);
    const b = without.map(dev);
    const diff = (mean(a) - mean(b)) * 100;
    const spread = pstdev(a) * 100;
    rows.push({
      key: t.key,
      label: t.label,
      days: withDays.length,
      diffPct: Math.round(diff * 10) / 10,
      spreadPct: Math.round(spread),
      meaningful: Math.abs(diff) > spread && spread > 0,
    });
  }
  return { rows, sampleDays: days.length };
}

// ── 특식·행사별 효과 ───────────────────────────────────────────
//
// "어떤 특식·행사에 실제로 사람이 몰렸나"를 행사별로 보여줍니다. 날씨와 반대로 "더 오시는"
// 방향이라 +로 나옵니다. 그 달 평균·요일 버릇을 걷어낸 편차로 재고, 행사가 없는 평범한 날을
// 기준으로 삼아 행사일이 평소보다 몇 %p 더 왔는지 계산합니다.
export interface SpecialEventImpact {
  date: string;
  label: string;
  present: number;
  diffPct: number; // 평소(그 달·요일 기준) 대비 +%p
}

export function getSpecialEventImpact(): { events: SpecialEventImpact[]; normalDays: number } {
  const active = getActiveResidents();
  if (!active.length) return { events: [], normalDays: 0 };

  const count = new Map<string, number>();
  for (const d of OPERATING_DAYS) {
    let n = 0;
    for (const r of active) if (r.attendance[d]) n++;
    count.set(d, n);
  }
  // 기준(평소)은 행사·감축운영이 아닌 평범한 운영일에서만 잡습니다.
  const normal = OPERATING_DAYS.filter((d) => !getMenuEvent(d) && !REDUCED_OPERATION.has(d));
  const byMonth = new Map<string, number[]>();
  for (const d of normal) {
    const m = d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(count.get(d)!);
  }
  const monthAvg = new Map<string, number>();
  for (const [m, list] of byMonth) monthAvg.set(m, list.reduce((a, b) => a + b, 0) / list.length);
  const wd = (d: string) => parseDateStr(d).getDay();
  const wdRatio = new Map<number, number[]>();
  for (const d of normal) {
    const avg = monthAvg.get(d.slice(0, 7));
    if (avg && avg > 0) {
      if (!wdRatio.has(wd(d))) wdRatio.set(wd(d), []);
      wdRatio.get(wd(d))!.push(count.get(d)! / avg);
    }
  }
  const wdFactor = new Map<number, number>();
  for (const [k, list] of wdRatio) wdFactor.set(k, list.reduce((a, b) => a + b, 0) / list.length);

  const events: SpecialEventImpact[] = [];
  for (const d of OPERATING_DAYS) {
    const label = getMenuEvent(d);
    if (!label) continue;
    const base = (monthAvg.get(d.slice(0, 7)) ?? 0) * (wdFactor.get(wd(d)) ?? 1);
    const present = count.get(d) ?? 0;
    const diff = base > 0 ? (present / base - 1) * 100 : 0;
    events.push({ date: d, label, present, diffPct: Math.round(diff * 10) / 10 });
  }
  // 많이 몰린 순으로.
  events.sort((a, b) => b.diffPct - a.diffPct);
  return { events, normalDays: normal.length };
}

const DOW_NAMES = ["월", "화", "수", "목", "금"];

/**
 * 요일 리듬을 한 문장으로.
 *
 * 점수에는 요일이 이미 녹아 있습니다 — 월·수·금에만 오시던 분의 **월요일 결석 한 번이
 * 화요일 결석 1,057번**과 같은 무게입니다(실측). 그런데 화면이 그 얘기를 한 번도 안 해서,
 * 담당자에게는 요일을 안 보는 것처럼 보였습니다. 계산에 쓰는 것을 화면에도 적습니다.
 */
export function describeDowPattern(p: { usual: number[]; missed: number[] } | null): string {
  if (!p || p.usual.length === 0) return "";
  const days = p.usual.map((wd) => DOW_NAMES[wd - 1]).join("·");
  const missed = p.usual
    .map((wd, i) => (p.missed[i] > 0 ? `${DOW_NAMES[wd - 1]} ${p.missed[i]}번` : null))
    .filter(Boolean);
  if (missed.length === 0) return `평소 ${days}요일에 오시던 분입니다`;
  return `평소 ${days}요일에 오시던 분인데, 그 뒤로 ${missed.join(" · ")} 건너뛰셨습니다`;
}

/** 재발을 몇 달까지 거슬러 세는지. 반년을 넘어가면 같은 사건으로 보기 어렵습니다. */
export const RELAPSE_WINDOW_DAYS = 180;

/**
 * 판정을 그만두는 경계 = 기준선 창 그 자체.
 *
 * 한동안 이 값이 21(한 달)이었고, 넘긴 분들을 「📦 오래 안 나오시는 분」 목록으로
 * 옮겼습니다. 그런데 8월 화면에 53명(위기 18·주의 24)이 쌓였습니다 — 지난 4년치를
 * 한꺼번에 불러오며 생긴 자료라, 담당자가 오늘 할 수 있는 일이 없는 명단이 매일
 * 대시보드를 차지했습니다. 목록을 지우고 판정에서 빼기로 했습니다.
 *
 * 왜 하필 {@link BASELINE_DAYS} 인가 — 우리 판단은 「직전 60 운영일의 리듬」 위에 서
 * 있습니다. 그 창이 전부 결석으로 채워지면 견줄 리듬 자체가 없습니다. 그 위에서 나온
 * 점수는 근거가 아니라 잔재입니다. 두 값을 따로 두면 또 어긋나므로 같은 값을 씁니다.
 */
export function getLongAbsenceBoundary(): number {
  // ⚠️ DB 의 `long_absence_days` 는 **읽지 않습니다.**
  //
  //   그 설정을 고르던 관리자 화면은 `018ba4e`(외부변수 정리)에서 없어졌는데, 값만
  //   남았습니다. 선택지가 0·21·42·63·84 인데 거기 없는 **7** 이 들어 있었고, 아무도
  //   그걸 바꿀 수 없었습니다. 그 값을 그대로 쓰게 했더니 실제로 이렇게 됐습니다 —
  //
  //     📞 연락할 분           0명      ← 7 운영일 넘은 분이 전부 이관돼 아무도 안 남음
  //     📦 오래 안 나오시는 분  80명
  //
  //   화면에서 고칠 수 없는 값이 판정 동작을 삼키는 구조는 두면 안 됩니다. 기관이 정한
  //   21 운영일을 코드에 두고, 나중에 다시 조절이 필요해지면 **조작 화면과 함께**
  //   되살립니다. 값만 있고 손잡이가 없는 상태로는 돌려놓지 않습니다.
  return BASELINE_DAYS;
}

/**
 * 재발 횟수 — **개입한 뒤 다시 나오셨다가, 또 끊긴** 횟수입니다.
 *
 * 왜 필요한가. 절벽점수는 마지막으로 오신 날부터 **0에서 다시 시작**합니다. 그래서
 * 7월에 연락드리고 8월에 나오셨다가 또 끊기신 분이, 이번에 처음 끊기신 분과 화면에서
 * 완전히 똑같이 보입니다 —
 *
 *   7월에 처음 끊기신 분          절벽 24.4  🔴 위기
 *   7월에 개입 → 복귀 → 또 끊김   절벽 24.4  🔴 위기   ← 구분이 안 됩니다
 *
 * 현장에서 이 둘은 다른 분입니다. 한 번 끊긴 것은 사정일 수 있지만, 연락이 닿아
 * 돌아오셨다가 또 끊기는 것은 **쇠약의 궤적**입니다. 재가 전환을 볼 자리이고,
 * 같은 「일시적사정」이라도 두 번째부터는 그 말을 그대로 믿으면 안 되는 자리입니다.
 *
 * 세는 법 — 지난 {@link RELAPSE_WINDOW_DAYS}일 안의 확인 기록 중, **그 뒤에 실제로
 * 나오신 날이 있는** 것을 셉니다. 나오셨다는 것은 그 회차가 복귀로 닫혔다는 뜻이고,
 * 지금 또 안 나오고 계시다면 그게 재발입니다. 기록만 있고 그 뒤로 한 번도 안 나오신
 * 경우는 **같은 한 번의 결석**이므로 세지 않습니다(두 번 연락드린 것뿐입니다).
 */
export function getRelapseCount(r: Resident, asOfStr: string): number {
  asOfStr = clampAsOf(asOfStr);
  const cutoff = followupCutoff(asOfStr);
  const since = toDateStr(addDays(parseDateStr(asOfStr), -RELAPSE_WINDOW_DAYS));

  // 먼저 해당 기간의 확인 기록부터 모읍니다. 대부분의 어르신은 여기서 0으로 끝나므로
  // 아래 방문일 정렬을 건너뜁니다(400명 × 매 계산마다 도는 자리입니다).
  const marks: string[] = [];
  for (const f of FOLLOWUPS) {
    if (f.residentId !== r.id) continue;
    if (f.checkedAt < since || f.checkedAt > cutoff) continue;
    // 종결은 세지 않습니다 — 돌아가셨거나 전출하신 분의 "복귀"는 없습니다.
    if (isClosedFollowup(f)) continue;
    marks.push(f.checkedAt);
  }
  if (marks.length === 0) return 0;

  const visits = Object.keys(r.attendance)
    .filter((d) => r.attendance[d] && d <= asOfStr)
    .sort();
  if (visits.length === 0) return 0;

  // ★ **결석 구간**을 셉니다. 확인 기록 건수가 아닙니다.
  //
  //   처음에는 "마지막 방문일보다 앞선 기록"을 그냥 세었습니다. 그런데 이 앱은 한 번의
  //   결석에 **여러 번 연락하도록** 만들어져 있습니다 — 부재중이면 목록에 남겨 다시 걸게
  //   하고, 3회 쌓이면 방문 명단으로 올립니다(UNREACHABLE_ESCALATE). 그래서 —
  //
  //     한 번 끊기심 → 전화 3번(다 부재중) → 복귀  →  예전 계산: 재발 3회  ❌
  //
  //   화면에 「재발 4회째」가 뜨고, 그 숫자가 AI 프롬프트에 **사실로 못 박혀** 갑니다.
  //   "반드시 짚어주세요"까지 붙으므로, 담당자는 한 번 끊기신 분에 대해 "세 번이나
  //   반복해서 끊기셨다"는 문장을 읽게 됩니다. 순위 가산도 9점(관찰 문턱 3개분)입니다.
  //
  //   그래서 기록마다 **그 뒤 처음 나오신 날**을 찾아, 그 날짜가 몇 가지인지 셉니다.
  //   같은 결석 구간에 적은 기록들은 복귀일이 하나로 같으므로 한 번으로 묶입니다.
  const closedBy = new Set<string>();
  for (const m of marks) {
    const back = visits.find((d) => d > m);
    if (back) closedBy.add(back);
  }
  return closedBy.size;
}

// ── 조기개입 우선순위 목록 ──────────────────────────────────
//
// 이 도구의 목적: 나오시던 어르신이 갑자기 안 나오면, 사고가 나기 전에 먼저 연락하기.
// 담당자는 적고 대상은 많으니, "제외"가 아니라 "순위"로 풉니다 — 아무도 빼지 않고,
// 가장 뜻밖인 결석부터 줄을 세워 위에서부터 감당되는 만큼 연락합니다.
//
// 핵심 지표: **그 어르신 평소 리듬으로 볼 때, 이만큼 연속으로 안 나오는 게 우연일 확률**.
//   평소 90% 나오시는 분이 5일 결석 → (1-0.9)^5 = 0.001% → 최우선
//   평소 20% 나오시는 분이 5일 결석 → (1-0.2)^5 = 33%    → 평소 그럼, 신호 아님
// 이렇게 하면 자주 오시던 분이 자연히 위로 오고, 가끔 오시는 분은 정말 이례적으로 오래
// 끊겼을 때만 올라옵니다(지우는 게 아니라 순위가 낮을 뿐).
//
// 두 갈래로 나눕니다:
//   · 조기개입   최근에 끊긴 뜻밖의 결석 → 사고 예방. 지금 연락.
//   · 안부확인   오래 끊긴 분 → 이미 놓치지 않았는지 확인하는 느린 트랙(빼는 게 아님).

export interface WorklistEntry {
  resident: Resident;
  /** 그날의 등급. 목록 줄에 배지를 그릴 때 씁니다. */
  level: RiskLevel;
  /**
   * 안심 처리로 가려지기 **전**의 등급.
   *
   * 사유를 확인해 기한을 걸면 level 이 normal 로 바뀝니다. 그래야 「오늘 연락할 분」에서
   * 빠지니까요. 그런데 그러면 「이번 달 위기 몇 명」을 셀 때 그분이 사라져, 화면에
   * 위기 1명이라고 적히면서 실제로는 열한 분이 위기였던 달이 있었습니다.
   * 가린 것과 괜찮아진 것은 다릅니다 — 원래 등급을 함께 담아 둡니다.
   */
  levelBeforeSnooze?: RiskLevel;
  /** 평소 리듬(첫 방문~마지막 방문 구간 출석률 %) */
  baselineRate: number;
  /** 화면에 "주 N회쯤 오시던 분"이라고 적을 때 쓰는 값. 마지막 방문일 기준이라
   *  결석이 길어져도 깎이지 않습니다(판정에는 쓰지 않습니다). */
  habitRate: number;
  /** 운영일 기준 연속결석 일수(사람 몰린 행사일은 복귀로 안 침) */
  consecutiveAbsence: number;
  lastDate: string | null;
  /** 이만큼 안 나오는 게 그 사람 평소 리듬상 우연일 확률(0~1). 작을수록 이례적 */
  chanceProb: number;
  mealTier: Resident["mealTier"];
  /** 지난 반년 안에 「개입 → 복귀 → 또 끊김」이 몇 번 있었는지. 0이면 이번이 처음입니다. */
  relapseCount: number;
  /** 평소 가장 길게 쉬신 기간(운영일). 0이면 잴 근거가 없습니다. */
  usualMaxGap: number;
  /** 요일 리듬. 매일 고르게 오시는 분은 null. */
  dowPattern: { usual: number[]; missed: number[] } | null;
  /** 지금 결석이 그 평소 선을 넘겨 등급이 한 단계 올라갔나. */
  rhythmBreak: boolean;
  /**
   * 목록을 세우는 값 = 절벽점수 + 재발 한 번당 {@link LEVEL_WATCH}점.
   *
   * **등급에는 쓰지 않습니다.** 재발했다고 🟡이 🔴이 되지는 않습니다 — 등급은 "이 결석이
   * 얼마나 뜻밖인가"이고 그건 이번 결석만으로 재는 것이 맞습니다. 다만 같은 점수라면
   * 두 번째로 끊기신 분을 먼저 뵙는 것이 맞아서, **줄 세우는 데만** 얹습니다.
   * 한 번당 3점은 「관찰」 문턱 하나만큼입니다 — 재발 한 번 = 한 단계 더 급함.
   */
  priority: number;
  /** 이름 옆 한 줄 요약용 키워드. 예: ["급격한 이탈","확인이 늦어질 수 있음"] */
  keywords: string[];
  /** 무슨 신호로 잡혔나: 급성(연속결석)·만성(서서히 감소)·관측불가. */
  signal: "acute" | "chronic" | "undetectable";
  /** 최근 30일 출석률(%). 만성 판단·표시에 씁니다. */
  recentRate: number;
  /** "사유 확인됨"으로 안심 처리된 경우 그 기한(YYYY-MM-DD). 확인됨 목록 표시에 씁니다. */
  snoozeUntil?: string;
  /** 그 사유(확인 기록 내용). */
  snoozeReason?: string;
}

export interface RiskWorklist {
  /** 메인 대시보드: 긴급🔴 + 위기🟠 (절벽점수 내림차순). */
  earlyIntervention: WorklistEntry[];
  /** 관심🟢 — 계산은 하되 대시보드에는 올리지 않습니다(담당자가 할 일이 없는 분들). */
  observe: WorklistEntry[];
  /** 하락 신호(월간 검토 목록). 절벽점수와 합치지 않는 별도 통로. */
  declineList: WorklistEntry[];
  /** 관측불가(baseline<7%) = 판단 어려움. 별도 명단. */
  undetectable: WorklistEntry[];
  /** 담당자가 사유를 확인해 다음 확인 시점 처리한 분들(기한 지나면 자동 복귀). */
  acknowledged: WorklistEntry[];
  /** 판단에 쓴 인원(기회일 20일 이상) */
  reviewed: number;
  /** 아직 자료가 적어 판단을 미룬 인원 */
  notEnough: number;
}

// ── 위기 감지 v2 설정값 (구현요청서 12장 · 4년치 검증으로 확정) ──────────────
/**
 * 기준선 — **직전 60 운영일.** 이 값 하나로 정합니다.
 *
 * 왜 60인가: 이 기관의 운영일은 한 달에 스무 날 안팎이라 **60 운영일이 달력으로 석 달**
 * 입니다. 담당자가 "요즘 어떠신지"를 물을 때 견주는 기간이 딱 그만큼입니다. 더 길게 잡으면
 * 넉 달 전 여름 패턴이 "평소"에 섞여 들어옵니다.
 *
 * 잃는 것도 적어 둡니다. 요일별로 나눠 보기 때문에 한 요일당 표본이 줄고, 그만큼 "이분의
 * 평소 화요일"이 덜 안정적이 됩니다. 어쩌다 화요일에 두어 번 빠진 것이 평소 패턴처럼
 * 잡힐 수 있다는 뜻입니다. **불필요한 알림이 늘었다 싶으면 이 값을 먼저 의심하십시오.**
 *
 * 더 늘리는 쪽은 권하지 않습니다. 4년치 검증(표본 17,685건)에서 창이 길어질수록 예측력이
 * 떨어졌고, 여섯 달쯤부터는 뚜렷하게 나빠집니다. 오래된 리듬을 "평소"라고 부르면 지금의
 * 변화가 묻힙니다.
 *
 * 판정 문턱(3/10/18)은 이 값과 함께 맞춰진 것입니다. **창을 바꾸면 문턱도 같이 다시
 * 재야 합니다** — 한쪽만 건드리면 무엇 때문에 달라졌는지 알 수 없게 됩니다.
 */
export const BASELINE_DAYS = 60;
export const TIER_UNOBSERVABLE = 0.07; // 이 미만이면 관측불가(판단 어려움)
export const TIER_DELAYED = 0.15; // 이 미만이면 관측지연('확인이 늦어질 수 있음' 표시)
export const LEVEL_WATCH = 3; // 🟢 관심
export const LEVEL_RECOMMEND = 10; // 🟠 위기
export const LEVEL_IMMEDIATE = 18; // 🔴 긴급
/**
 * ── 개인 결석 리듬 (사양 4장의 「개인 기준선」을 빈도가 아니라 **간격**으로 보는 축) ──
 *
 * 절벽점수는 「얼마나 자주 오시던 분인가」만 봅니다. 그런데 현장에서 위험한 신호는
 * 빈도가 아니라 **리듬이 깨진 것**입니다 —
 *
 *   주 3회 오시는데 결석해도 **늘 이틀 안에** 돌아오시던 분이 8일째
 *     → 빈도로만 보면 60%짜리 결석 8일 = 절벽 7.5점 = 🟢관심 (긴급은 27일째)
 *     → 리듬으로 보면 **평소의 네 배**. 무슨 일이 생긴 것입니다.
 *
 * 이 값은 이미 계산하고 있었는데(typicalAbsenceStreak) **화면에 글자만 찍고 등급에는
 * 안 썼습니다.** 판정 함수가 그 값을 보지도 않았습니다.
 *
 * 「평균」이 아니라 **「평소 가장 길게 쉬신 기간」**을 씁니다. 평균은 너무 예민합니다 —
 * 주 3회 오시는 분의 평균 결석 간격은 1일이라 나흘만 빠져도 네 배가 됩니다. 최댓값은
 * "이분이 평소 이 정도까지는 쉬셨다"는 선이고, 그 선을 넘었을 때가 이상 신호입니다.
 * 담당자에게 설명하기도 이쪽이 쉽습니다.
 */
export const RHYTHM_MULT = 1.5; // 평소 최장 결석의 몇 배를 넘겨야 리듬이 깨진 것으로 볼지
export const RHYTHM_MIN_DAYS = 4; // 이보다 짧으면 안 봅니다(하루 이틀은 늘 있는 일)

export const DECLINE_SHORT = 15; // 하락: 최근 창(운영일)
export const DECLINE_LONG = 45; // 하락: 비교 창(운영일)
export const DECLINE_THRESHOLD = 7; // 하락 신호 임계
export const WINTER_JAN = 0.82; // 1월 계절 반영
export const WINTER_DEC_FEB = 0.87; // 12·2월 계절 반영
export const ADJUST_FLOOR = 0.5; // 계절 반영 하한(원래 값의 50% 아래로 못 내림)

// 표준정규 누적분포(하락 통로 z→확률). Abramowitz-Stegun 근사.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  let p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  p = z >= 0 ? 1 - p : p;
  return p;
}

// 계절 보정: 겨울(1월·12·2월)만 출석 확률을 낮춰 불필요한 알림을 줄이되, 하한(50%)으로 완전히
// 눈감지는 않습니다(노인 위기가 겨울에 가장 많음). 그 외 달은 그대로.
function seasonalP(p: number, dateStr: string): number {
  const month = Number(dateStr.slice(5, 7));
  let adj = p;
  if (month === 1) adj = p * WINTER_JAN;
  else if (month === 12 || month === 2) adj = p * WINTER_DEC_FEB;
  return Math.max(adj, p * ADJUST_FLOOR);
}

/**
 * 한 어르신의 위기 신호를 판정하는 단일 기준입니다.
 *
 * 화면 곳곳에서 위기·주의를 세는데, 예전에는 KPI(등급 점수제)와 조기개입 목록(순위제)이
 * 서로 다른 수식·기준선을 써서 같은 사람인데 한쪽에만 잡히고 숫자가 안 맞았습니다. 그래서
 * "이 사람이 위기인가"를 정하는 판단을 여기 한 곳으로 모읍니다. getRiskWorklist(조기개입
 * 목록)와 getAiRiskAssessment(등급·서술)가 모두 이 함수를 기준으로 삼습니다.
 *
 *   bucket = early   → level "crisis" (지금 먼저 연락할 분)
 *   bucket = early → 점수에 따라 level "crisis"(긴급) 또는 "caution"(위기)
 *   bucket = observe → level "concern"(관심)
 *   bucket = acknowledged → level "normal" (원래 등급은 levelBeforeSnooze 에)
 *   bucket = notEnough · undetectable · none → level "normal" / "unknown"
 */
// early=긴급🔴+위기🟠(메인) · observe=관심🟢(화면에 안 올림) · undetectable=관측불가(판단 어려움)
// · acknowledged=사유 확인 안심 처리 · none=정상 · notEnough=자료 부족.
type RiskBucket = "notEnough" | "undetectable" | "none" | "early" | "observe" | "acknowledged";
interface RiskClassification {
  bucket: RiskBucket;
  level: RiskLevel;
  signal: WorklistEntry["signal"] | "none";
  baselineRate: number; // 기준선 창(BASELINE_DAYS) 출석률 (0~100, 반올림) — **판정용**
  /**
   * 평소 얼마나 자주 오시던 분인지 — **화면에 보여주는 용도**입니다.
   *
   * baselineRate 와 나누는 이유: 그쪽은 **오늘 이전 60 운영일**로 잽니다. 그래서 오래
   * 안 나오실수록 낮아집니다. 실제로 이렇게 나왔습니다 —
   *
   *   29일째 안 나오심 → "주 1회쯤 오시던 분"
   *   52일째 안 나오심 → "2주에 한 번쯤 오시던 분"
   *
   * 주 3회 꼬박 오시던 분인데 결석이 길다는 이유로 "원래 뜸하던 분"이 됩니다. 담당자가
   * 아는 사실과 어긋나면 그 줄을 안 믿게 됩니다.
   *
   * 그렇다고 판정용 기준선을 옮기면 안 됩니다 — 창을 마지막 방문일에서 끊어 보니 넉 달째
   * 안 나오시는 분까지 전부 위기로 올라와 50명이 됐습니다. 지금 방식의 그 성질이 이미
   * 발길을 끊으신 분으로 명단이 채워지는 것을 막아 주고 있습니다.
   *
   * 그래서 **판정은 그대로 두고 표시만 따로 잽니다.** 이 값은 마지막으로 오신 날까지의
   * 60 운영일로 계산합니다 — 결석이 시작되기 전의 리듬입니다.
   */
  habitRate: number;
  recentRate: number; // 최근 30일 출석률 (0~100, 표시용)
  chanceProb: number; // 연속결석이 우연일 확률 = e^{-절벽점수} (내부용, 화면 표시 안 함)
  cliffScore: number; // 절벽 점수(연속결석 누적)
  declineScore: number; // 하락 점수(서서히 감소)
  tier: "관측가능" | "관측지연" | "관측불가";
  /** 관측 등급을 재는 창(마지막 방문일까지 60 운영일)에서 실제로 오신 날 수. */
  judgedDays: number;
  /**
   * 요일 리듬 — 「무슨 요일에 오시던 분인가」와 「그 요일을 몇 번 건너뛰셨나」.
   *
   * 매일 고르게 오시는 분은 null 입니다(그분께 「월화수목금에 오시던 분」이라고 적는
   * 것은 아무 말도 안 하는 것입니다). usual 은 요일 번호(1=월 … 5=금),
   * missed 는 같은 순서로 그 요일을 건너뛴 횟수입니다.
   */
  dowPattern: { usual: number[]; missed: number[] } | null;
  /** 평소 가장 길게 쉬신 기간(운영일, 기준선 창 안). 0이면 잴 근거가 없습니다. */
  usualMaxGap: number;
  /** 지금 결석이 그 평소 선을 넘겼나 — 넘겼으면 등급을 한 단계 올립니다. */
  rhythmBreak: boolean;
  consecutiveAbsence: number;
  chronic: boolean; // = 하락 신호(declineScore>=임계). 키워드·목록 분기에 씀
  acute: boolean; // = 절벽 신호(관찰 이상)
  snoozeUntil?: string;
  snoozeReason?: string;
  /**
   * 안심 처리로 가리기 **전의** 등급.
   *
   * 안심은 "괜찮다"가 아니라 "오늘은 연락 안 해도 된다"입니다. 그런데 level 을
   * normal 로 덮어써서, 화면에 이런 분이 생겼습니다 —
   *
   *   홍○동 어르신 · 연속결석 52일 · 절벽 18.1점(위기 문턱 18)
   *   화면 등급: 「정상」
   *   AI 설명:  "평소 주 2회 꾸준히 오시던 어르신이 39일간 나오지 않고 있습니다.
   *              먼저 연락하여 확인해 주시는 것이 좋겠습니다"
   *
   * 「정상」 옆에서 AI가 연락하라고 합니다. 기한이 지나 다시 떠도 담당자는 "어제까지
   * 정상이던 분이 왜?" 하고 읽습니다. 가린 것과 괜찮은 것은 다릅니다.
   */
  levelBeforeSnooze?: RiskLevel;
}

/**
 * 지금(asOf) 시점에 "사유 확인됨"으로 안심 처리된 상태인지.
 *
 * 가장 최근 확인 기록이 (a) 지금은 괜찮으심이고 (b) 안심 기한(snoozeUntil)이 있으며 (c) 그 기록이
 * asOf 이전이고 (d) asOf가 아직 기한 안이면 → 스누즈 중. 기한이 지나면 자동으로 풀려 다시
 * 위기 목록에 올라옵니다. 최근 기록이 "개입 필요"면 스누즈는 해제된 것으로 봅니다.
 */
/** 복귀 후 이 운영일 수만큼 판정을 미룹니다 (구현요청서 9-3, RESUME_OBSERVE_DAYS). */
export const RESUME_OBSERVE_DAYS = 30;
/** 확인 불가가 이만큼 쌓이면 방문 확인 목록으로 올립니다 (9-2, UNREACHABLE_ESCALATE). */
export const UNREACHABLE_ESCALATE = 3;

export interface MemberState {
  status: WatchStatus;
  /** 이 날까지는 판정하지 않습니다(복귀 직후 새 리듬을 익히는 기간). */
  observeUntil: string | null;
  /** 약속한 복귀일이 지났는데 안 나오셔서 다시 올라온 경우 */
  resumeOverdue: boolean;
  /** 왜 이 상태인지 — 화면에 그대로 보여줍니다 */
  reason: string;
  /** 연락이 안 된 횟수(마지막 확인 이후 연속). 3회면 방문 확인 대상입니다. */
  unreachableStreak: number;
  /**
   * 종결했는데 그 뒤로 다시 급식에 나오고 계신 분.
   *
   * 종결은 사람이 내린 결정이라 자동으로 풀지 않습니다. 다만 결정과 사실이 어긋났다는
   * 것은 알려야 합니다 — 전언으로 잘못 종결하면 매일 오시는 분이 시야에서 사라집니다.
   */
  reopenCandidate?: boolean;
  /**
   * 이 상태 판단에 **실제로 쓴** 복귀 약속일.
   *
   * 화면이 이 값을 그대로 보여줘야 합니다. 예전에는 화면 쪽(getResumeOverdue)이 최신
   * 기록을 **따로 다시 골랐는데**, 여기와 정렬 기준이 달라 같은 날 기록이 둘이면 서로
   * 다른 건을 집었습니다. 그래서 실제로 이런 화면이 나왔습니다 —
   *
   *   성○향 어르신 · 9/17 에 기록 두 건
   *     2차 "추석 지나고 다시 나오시기로 함"  복귀일 09-28
   *     1차 (사유 없음)                      복귀일 없음
   *   → 판단은 1차로(옛 날짜가 지났다고), 표시는 2차로(09-28)
   *   → 「나오신다고 하신 날이 지났습니다 · 9월 28일」 (아직 열흘 남았는데요)
   *
   * 한 줄 안에서 앞뒤가 안 맞으면 담당자는 목록 전체를 안 믿습니다.
   */
  promised: string | null;
}

/**
 * 어르신의 **지금** 감시 상태 (구현요청서 9장).
 *
 * DB에 적힌 값을 그대로 쓰지 않고 출결까지 보고 계산합니다. 9-1이 "보류는 출석 1건 발생 시
 * 자동 해제"라고 정해두었기 때문입니다 — 이걸 사람이 눌러서 풀어야 하면 결국 아무도 안 눌러
 * 돌아오신 분이 계속 보류로 남습니다.
 *
 * 9-3: 보류가 풀린 뒤 30 운영일은 판정하지 않습니다. 옛 기준선(주 5회)을 그대로 쓰면 복귀
 *      직후에 계속 이탈로 뜹니다. 그 기간 기록으로 평소를 다시 잡습니다.
 * 9-4: "추석 이후 나올 예정"이라 하셨는데 그날이 지나도 안 나오시면 그게 진짜 신호입니다.
 *      담당자가 달력에 적어두고 기억할 필요가 없게 만듭니다.
 */
export function getMemberState(resident: Resident, asOfStr: string = DATA_END_STR): MemberState {
  asOfStr = clampAsOf(asOfStr);
  const cutoff = followupCutoff(asOfStr);
  const history = FOLLOWUPS.filter(
    (f) => f.residentId === resident.id && f.checkedAt <= cutoff,
  ).sort((a, b) =>
    a.checkedAt !== b.checkedAt ? (a.checkedAt < b.checkedAt ? 1 : -1) : b.id.localeCompare(a.id),
  );

  // 연락이 연달아 안 된 횟수. 중간에 한 번이라도 통화가 됐으면 거기서 끊습니다.
  let unreachableStreak = 0;
  for (const f of history) {
    if (f.resultKind === "확인불가" || f.outcome === "no_answer") unreachableStreak++;
    else break;
  }

  const latest = history[0];
  const base: MemberState = {
    status: "감시중",
    observeUntil: null,
    resumeOverdue: false,
    reason: "",
    unreachableStreak,
    promised: null,
  };
  if (!latest) return base;

  const kind = latest.resultKind;
  // 표에 없는 갈래(예전에 쓰다 없앤 값)가 DB 에 남아 있을 수 있습니다.
  // 그때는 「감시중」으로 봅니다 — 모르는 값 때문에 어르신이 목록에서 사라지면 안 됩니다.
  const declared = kind ? (RESULT_KIND_META[kind]?.status ?? null) : null;

  // 「종결 처리」 단추로 남긴 기록은 갈래(resultKind)가 비어 있습니다.
  //
  // 그래서 "[종결] 멀리 이사 가심"이라고 적어 놓고도 이 함수는 그분을 **감시중**으로
  // 봤습니다. 화면에는 「정상·활동중」으로 남아 위기 계산에 계속 들어가고, 「잠시 제외」
  // 상자에도 뜹니다 — 담당자는 분명히 종결했는데요.
  //
  // 적어 둔 말이 사실입니다. 갈래가 비어 있어도 [종결] 이라고 적었으면 종료입니다.
  const closedByNote = latest.note.startsWith("[종결]");

  // 종료는 자동 해제가 없습니다(9-1). 돌아가셨거나 이사 가신 분입니다.
  if (declared === "종료" || closedByNote || resident.watchStatus === "종료") {
    const closeReason = kind
      ? (RESULT_KIND_META[kind]?.label ?? "종결 처리")
      : closedByNote
        ? latest.note.replace("[종결] ", "")
        : "종결 처리";

    // ★ 종결한 뒤에 **다시 급식에 나오시는 분**을 알려 드립니다.
    //
    //   예전에는 이 분기가 출결을 아예 보지 않았습니다. 그래서 5월에 「이사전출」로
    //   종결된 분이 그 뒤 매일 빠짐없이 나오셔도 어느 목록에도 없었습니다 —
    //   연락할 분에도, 판정 못 한 분에도, 방문 대상에도. 「사례 관리 종료」 상자에만
    //   조용히 남습니다. 바로 아래 보류 분기는 출석 한 건이면 자동 해제하는데,
    //   종료 분기만 눈을 감고 있었습니다.
    //
    //   종결은 사람이 내린 결정이라 자동으로 풀지 않습니다. 다만 **결정과 사실이
    //   어긋났다는 것은 알려야 합니다.** 전언으로 잘못 종결하거나 단추를 잘못 누른
    //   경우, 매일 밥 잡수러 오시는 분이 기관 시야에서 영원히 사라지기 때문입니다.
    const cameBackDays = OPERATING_DAYS.filter(
      (d) => d > latest.checkedAt && d <= asOfStr && resident.attendance[d],
    );
    if (cameBackDays.length > 0) {
      return {
        ...base,
        status: "종료",
        reopenCandidate: true,
        reason: `${closeReason}으로 종결했는데 그 뒤 ${cameBackDays.length}번 나오셨습니다 (마지막 ${cameBackDays[cameBackDays.length - 1].slice(5)}) — 종결이 맞는지 확인해 주세요`,
      };
    }

    return { ...base, status: "종료", reason: closeReason };
  }

  if (declared !== "보류") return base;

  // 보류 이후 출석이 한 번이라도 있으면 자동 해제 + 30 운영일 판정 유예.
  const after = OPERATING_DAYS.filter(
    (d) => d > latest.checkedAt && d <= asOfStr && resident.attendance[d],
  );
  if (after.length > 0) {
    const backAt = after[0];
    // 유예는 **판정에 쓰는 운영일**로 세야 합니다.
    //
    // OPERATING_DAYS 에는 밀키트·오류일·일괄발권이 그대로 들어 있습니다. 그걸로 세면
    // 유예가 최대 9 운영일 일찍 끝나고, 그러면 멀쩡히 돌아오신 분이 복귀 직후의 낮은
    // 출석 때문에 다시 위기로 뜹니다.
    //
    // ★ 그런데 **복귀하신 날이 그 제외일이면** indexOf 가 -1 이 되어 유예가
    //   judgedDays[29] — 자료 맨 앞 날짜가 됩니다. 이미 지난 날이니 유예가
    //   **통째로 사라집니다.** 밀키트 기간(넉 달)에 돌아오신 분이 정확히 그렇습니다.
    //   복귀 직후 낮은 출석률로 그날 바로 다시 위기로 떠, 멀쩡히 돌아오신 분께
    //   전화가 갑니다. 제외일에 오셨으면 **그 다음 판정일부터** 세기 시작합니다.
    const judgedDays = OPERATING_DAYS.filter((d) => !REDUCED_OPERATION.has(d));
    const found = judgedDays.indexOf(backAt);
    const idx = found >= 0 ? found : judgedDays.findIndex((d) => d > backAt);
    const until =
      idx >= 0
        ? judgedDays[Math.min(idx + RESUME_OBSERVE_DAYS, judgedDays.length - 1)]
        : judgedDays[judgedDays.length - 1];
    if (asOfStr <= until) {
      return {
        ...base,
        observeUntil: until,
        reason: `${backAt.slice(5)}에 다시 나오셨습니다 — ${until.slice(5)}까지는 새 리듬을 보는 기간입니다`,
      };
    }
    return base; // 유예 기간도 지났으면 평상 판정
  }

  // 약속한 복귀일이 지났는데 아직 안 나오셨습니다 → 다시 올립니다.
  const promised = latest.resumeExpected ?? resident.resumeExpected;
  if (promised && promised < asOfStr) {
    return {
      ...base,
      resumeOverdue: true,
      promised,
      reason: `${promised.slice(5)}에 나오신다고 하셨는데 아직 안 나오십니다`,
    };
  }

  // ★★ 보류에도 **끝이 있어야 합니다.**
  //
  //   여기까지 오면 상태가 「보류」이고, classifyRisk 맨 앞에서 판정이 끊깁니다.
  //   그런데 그 기록에 적어 둔 기한(snoozeUntil)은 **여기서 한 번도 읽히지
  //   않았습니다.** 풀리는 길이 둘뿐이었습니다 — 급식에 다시 나오시거나,
  //   복귀 예정일이 지나거나.
  //
  //   그리고 복귀 예정일을 못 적는 갈래가 있습니다. 「위기(입원·낙상)」와
  //   「일자리프로그램참여」는 화면에 복귀일 칸 자체가 안 뜹니다. 그 결과 —
  //
  //     2025-07-10  「위기 · 입원」으로 기록, 기한 2개월
  //     → 2026-08 까지 **14개월 내내** 어느 목록에도 없음
  //       (조기개입·관심·하락·판단어려움·확인됨 다섯 군데 전부)
  //
  //   입원은 **퇴원 뒤가 가장 위험**하고 노인일자리는 해마다 끝납니다. 그때
  //   아무 신호도 안 옵니다. 이 도구가 막으려던 「조용히 사라지는 것」을 이 도구가
  //   만들고 있던 셈입니다.
  //
  //   그래서 담당자가 고른 기한이 지나면 **보류를 풀고 판정으로 되돌립니다.**
  //   기한을 안 골랐으면 갈래별 기본값(suggestSnoozeDays)을 씁니다. 판정으로
  //   돌아온다고 바로 위기가 되는 것은 아닙니다 — 그동안 다시 나오셨으면 점수가
  //   낮고, 계속 안 나오셨으면 떠야 하는 것이 맞습니다.
  const pauseUntil =
    latest.snoozeUntil ??
    (kind ? toDateStr(addDays(parseDateStr(latest.checkedAt), suggestSnoozeDays(kind))) : null);
  if (pauseUntil && pauseUntil < asOfStr) {
    return {
      ...base,
      resumeOverdue: true,
      promised: promised ?? pauseUntil,
      reason: `${pauseUntil.slice(5)}까지 보기로 했는데 그 날이 지났습니다 — 다시 확인할 때입니다`,
    };
  }

  return {
    ...base,
    status: "보류",
    reason: kind ? (RESULT_KIND_META[kind]?.label ?? "확인 후 보류") : "확인 후 보류",
  };
}

export function getActiveSnooze(
  residentId: string,
  asOfStr: string,
): { until: string; reason: string } | null {
  asOfStr = clampAsOf(asOfStr);
  const latest = FOLLOWUPS.filter(
    (f) => f.residentId === residentId && f.checkedAt <= followupCutoff(asOfStr),
  ).sort((a, b) =>
    a.checkedAt !== b.checkedAt ? (a.checkedAt < b.checkedAt ? 1 : -1) : b.id.localeCompare(a.id),
  )[0];
  if (!latest) return null;
  // ⚠️ 부재중(no_answer)은 내려두지 않습니다.
  //
  // 예전에는 3일간 목록에서 뺐습니다. 이유는 "같은 분께 하루에 몇 번씩 전화하게 되면
  // 담당자도 지치고 어르신도 불편하다"였고, 그 걱정 자체는 맞습니다.
  //
  // 그런데 사양이 이것만은 못박아 두었습니다 —
  //   "확인 불가는 해제 사유가 아님. 연락이 안 되는 것 **자체가 위기 신호**
  //    (실제 확인 27명 중 8명이 연락 불가, 97세 독거 어르신 포함)"
  //
  // 전화가 안 되는 분이 사흘 동안 화면에서 사라지는 것은, 가장 걱정스러운 분을 가장 오래
  // 안 보이게 하는 일입니다. 전화 횟수를 줄이는 것은 목록에서 빼는 방법이 아니라 화면에
  // "부재중 N회째 · 마지막 시도 MM/DD"를 적어 담당자가 스스로 판단하게 하는 방법으로
  // 풉니다(getMemberState 의 unreachableStreak). 3회가 쌓이면 방문 목록으로 올라갑니다.
  const until = recheckDueDate(latest);
  if (!until) return null;
  if (asOfStr > until) return null;
  return { until, reason: latest.note };
}

function classifyRisk(r: Resident, asOfStr: string): RiskClassification {
  asOfStr = clampAsOf(asOfStr);
  const asOf = parseDateStr(asOfStr);
  const windowStart = addDays(asOf, -RECENT_WINDOW_DAYS);

  const k = getConsecutiveAbsence(r, asOfStr);

  const base = {
    consecutiveAbsence: k,
    recentRate: 0,
    judgedDays: 0,
    dowPattern: null,
    usualMaxGap: 0,
    rhythmBreak: false,
    chronic: false,
    acute: false,
    cliffScore: 0,
    declineScore: 0,
  };
  const notEnough = (): RiskClassification => ({
    bucket: "notEnough",
    // 「정상」이 아닙니다. 여기에는 돌아가신 분(종료)·입원 중인 분(보류)·복귀 관찰
    // 중인 분·기록이 3주도 안 되는 분이 전부 들어옵니다. level 을 normal 로 두면
    // 어르신 관리 화면에서 등급 「정상」으로 거르면 **돌아가신 분이 섞여 나옵니다.**
    // 판단하지 않은 것을 괜찮다고 말하지 않습니다(사양 7-1).
    level: "unknown",
    signal: "none",
    baselineRate: 0,
    habitRate: 0,
    chanceProb: 1,
    tier: "관측불가",
    ...base,
  });

  // ── 감시 상태 확인 (구현요청서 9장) ────────────────────────
  //
  // 6-1이 "status != '감시중'이면 계산 안 함"이라고 정해두었습니다. 돌아가셨거나 요양원에
  // 가신 분(종료), 입원 중이라 사정을 이미 아는 분(보류)까지 매일 명단에 올리면 담당자가
  // 목록 전체를 안 보게 됩니다. 복귀 직후 유예 기간(9-3)도 여기서 걸러집니다.
  const state = getMemberState(r, asOfStr);
  if (state.status !== "감시중") return notEnough();
  if (state.observeUntil && asOfStr <= state.observeUntil) return notEnough();

  // 운영일(주말·공휴일·휴관·리모델링·등록 전 제외).
  const days = opportunityDays(r, DATA_START_STR, asOfStr);
  if (days.length < 20) return notEnough();

  // ★ 기준선 창(60 운영일)을 통째로 넘겨 안 나오시면 **판정하지 않습니다.**
  //
  //   우리 판단은 「직전 60 운영일의 리듬」 위에 서 있습니다. 그 창이 전부 결석으로
  //   채워지면 견줄 리듬 자체가 없습니다 — 그 위에서 나온 점수는 근거가 아니라 잔재입니다.
  //
  //   한동안 이런 분들을 「📦 오래 안 나오시는 분」 목록으로 옮겨 두었는데, 8월 화면에서
  //   53명(그중 위기 18·주의 24)이 쌓였습니다. 지난 4년치를 한꺼번에 불러오면서 생긴
  //   자료라, 담당자가 오늘 할 수 있는 일이 없는 명단이 매일 대시보드를 차지했습니다.
  //
  //   다시 나오시면 그날부터 새로 쌓입니다 — k 가 0으로 돌아가고, 기준선 창이 그 방문을
  //   품기 시작합니다. 다만 창이 아직 결석으로 차 있어 한동안은 관측등급에 걸립니다.
  //   3주쯤 다시 다니시면 판정으로 돌아옵니다. "그 시점부터 다시 자료를 쌓는다"는
  //   말이 정확히 이 동작입니다.
  //
  //   ⚠️ 사라지는 것이 아닙니다. 통계 화면의 「판정해 본 적이 없는 분」 명단(getUnanalyzable)
  //   에 사유와 함께 남습니다. 여기서 빼는 것은 **오늘의 전화 목록**에서지, 기관의
  //   시야에서가 아닙니다.
  if (k > BASELINE_DAYS) return notEnough();

  // ── 기준선: 직전 60 운영일 + 요일별 확률 ─────────────────────
  //
  // 기준선은 "이분의 평소"입니다. 그런데 창이 오늘까지라서 **지금 안 나오고 계신 기간이
  // 평소 안에 들어옵니다.** 그러면 오래 안 나오실수록 "원래 안 오시던 분"이 되어, 길어질수록
  // 덜 위험해 보이는 거꾸로 된 계산이 됩니다.
  //
  // 이 뒤집힘은 **관측 등급을 정하는 자리에서** 막았습니다(아래 tier 계산). "급식으로 볼 수
  // 있는 분이었나"를 마지막으로 오신 날 기준으로 묻기 때문에, 결석이 길어져도 등급이
  // 되돌아가지 않습니다. 여기 기준선 값 자체는 사양대로 오늘 이전 창을 그대로 씁니다 —
  // 요일확률(dowProbAsOf)은 어차피 **그날 시점**으로 다시 잡으므로, 결석 첫날에는 결석이
  // 섞이지 않은 기준선이 쓰입니다.
  // 창은 **오늘 이전** BASELINE_DAYS 운영일입니다(사양 4장 "as_of_date 이전").
  // 오늘을 넣으면 오늘 하루가 기준선과 판정 양쪽에 들어가 자기가 자기 기준을 흔듭니다.
  // 아래 절벽 점수의 dowProbAsOf(i) 도 그날을 빼고 계산하므로, 두 곳이 같은 창을 씁니다.
  const baseEnd = Math.max(0, days.length - 1);
  const window = days.slice(Math.max(0, baseEnd - BASELINE_DAYS), baseEnd);
  let attendedInWindow = 0;
  for (const d of window) if (r.attendance[d]) attendedInWindow++;
  // 분모는 **창 길이가 아니라 60 고정**입니다 (사양 4장 baseline_rate = len(attended) / 60).
  // 창 길이로 나누면 기회일이 60일 안 되는 최근 등록자의 출석률이 과대평가돼,
  // 사양대로면 판단 어려움(관측불가)여야 할 분에게 점수가 매겨집니다. 근거 없는 숫자가
  // 나오면 담당자가 목록 전체를 불신합니다.
  const baseRate = attendedInWindow / BASELINE_DAYS;
  const baselineRate = Math.round(baseRate * 100);

  // ── 평소 얼마나 자주 오시던 분인가 (화면 표시 전용) ──────────
  //
  // 위 baselineRate 는 오늘 이전 60일이라 결석이 길수록 낮아집니다. 주 3회 꼬박 오시던
  // 분이 한 달 안 나오시면 "주 1회쯤 오시던 분"이 됩니다 — 담당자가 아는 사실과
  // 어긋나면 그 줄을 안 믿습니다.
  //
  // 여기서는 **마지막으로 오신 날까지**의 60 운영일로 잽니다. 결석이 시작되기 전의
  // 리듬이라, "평소 이렇게 오시던 분인데 지금 안 나오신다"는 말이 그대로 맞습니다.
  // 판정에는 쓰지 않습니다 — 판정 기준선을 옮기면 넉 달째 안 나오시는 분까지 전부
  // 위기로 올라옵니다(위 주석 참고).
  let lastVisitIdx = -1;
  for (let i = days.length - 1; i >= 0; i--) {
    if (r.attendance[days[i]]) {
      // 사람이 몰린 행사일은 여기서도 "오신 날"로 세지 않습니다.
      //
      // 아래 lastIdx(절벽점수 시작점)에는 예외를 넣으면서 **여기를 빠뜨렸습니다.**
      // 그런데 관측 등급(tier)이 이 값을 쓰고, tier 검사는 절벽 계산보다 **먼저**
      // 끝납니다. 그래서 넉 달 끊기셨다가 초복에 한 번 들르신 분이 —
      //
      //   lastIdx(절벽)     4월 그대로  → 점수는 여전히 높음
      //   lastVisitIdx(tier) 7/20 으로 이동 → 그 앞 60일이 전부 결석 → 1.7% → 관측불가
      //
      // 초복 **다음 날 🔴 위기가 「판단 어려움」으로 내려가 대시보드에서 사라집니다.**
      // 고치려던 바로 그 시나리오를 절반만 고쳐 놓은 셈이었습니다.
      if (CROWD_DAYS.has(days[i])) continue;
      lastVisitIdx = i;
      break;
    }
  }
  //
  // ⚠️ 창이 너무 짧으면 쓰지 않습니다.
  //
  // habitEnd 는 **항상 출석일**이라(마지막 방문), 기록 초반에 며칠 나오시고 발길을 끊은
  // 분은 창이 1~6일로 줄고 그 며칠이 전부 출석이라 100% 가 나옵니다. 그러면 메인 화면에
  // "거의 매일 오시던 분인데 24일째 안 나오십니다" 라고 뜹니다 — 평생 여섯 번 오신 분입니다.
  // 그 문구가 AI 프롬프트로도 들어가 설명 문장까지 틀어집니다.
  //
  // 창이 20일(기회일 게이트와 같은 값) 미만이면 "평소"를 말할 자료가 없는 것이므로
  // 판정용 기준선을 그대로 씁니다. 방문 기록이 아예 없는 분도 마찬가지입니다 —
  // 0회인데 describeVisitFrequency(0) 가 "한 달에 한두 번"으로 읽히면 안 됩니다.
  const HABIT_MIN_WINDOW = 20;
  let habitRate = baselineRate;
  if (lastVisitIdx >= 0) {
    const habitEnd = lastVisitIdx + 1; // 마지막 방문일까지 포함
    const habitWindow = days.slice(Math.max(0, habitEnd - BASELINE_DAYS), habitEnd);
    let came = 0;
    for (const d of habitWindow) if (r.attendance[d]) came++;
    // 분모는 실제 창 길이입니다. 여기서 알고 싶은 것은 "그 시절에 얼마나 자주 오셨나"라서,
    // 창이 짧으면 짧은 대로 그 기간의 리듬을 그대로 씁니다.
    if (habitWindow.length >= HABIT_MIN_WINDOW) {
      habitRate = Math.round((came / habitWindow.length) * 100);
    }
  }

  // 최근 30일 출석률(표시·참고용)
  const recentDays = opportunityDays(r, toDateStr(windowStart), asOfStr);
  let recentAttended = 0;
  for (const d of recentDays) if (r.attendance[d]) recentAttended++;
  base.recentRate = recentDays.length ? Math.round((recentAttended / recentDays.length) * 100) : 0;

  // ── 관측 등급 ──────────────────────────────────────────────
  //
  // ★ 오늘의 기준선이 아니라 **안 오시기 시작한 시점의 기준선**으로 정합니다.
  //
  //   사양은 이 계산을 매일 돌려 그날그날 쌓으라고 합니다. 우리는 화면을 그릴 때마다
  //   처음부터 다시 계산하는데, 그러면서 **오늘의 기준선 하나로 과거까지 판정**했습니다.
  //   그 결과가 이렇습니다(시뮬레이션 실측, 평소 거의 매일 오시던 분) —
  //
  //     결석 54일 | 그 시점 기준선 10.0% | 절벽 66.53 | 🔴 즉시확인
  //     결석 60일 | 그 시점 기준선  1.7% | 절벽 68.44 | 정상      ← 점수는 올랐는데 사라짐
  //
  //   기준선 창이 결석으로 다 채워져 "원래 안 오시던 분"이 되고, 관측불가로 걸러지면서
  //   **68점짜리 위기가 통째로 버려집니다.** 어제 🔴이던 분이 오늘 흔적 없이 사라집니다.
  //   사양 6-1의 tier 검사는 "더 쌓는 것을 멈춰라"이지 "쌓은 것을 버려라"가 아닙니다.
  //
  //   그래서 "이분이 평소에 급식으로 볼 수 있는 분이었나"를 **마지막으로 오신 날 기준**
  //   으로 묻습니다. 그때 관측 가능했다면 지금 안 보이는 것은 자료가 없어서가 아니라
  //   **안 나오고 계셔서**입니다. 그것이 바로 우리가 찾는 신호입니다.
  const tierEnd = lastVisitIdx >= 0 ? lastVisitIdx + 1 : baseEnd;
  const tierWindow = days.slice(Math.max(0, tierEnd - BASELINE_DAYS), tierEnd);
  let tierAttended = 0;
  for (const d of tierWindow) if (r.attendance[d]) tierAttended++;
  // 분모는 기준선과 같은 고정값입니다(사양 4장).
  const judgeRate = tierAttended / BASELINE_DAYS;
  const tier: RiskClassification["tier"] =
    judgeRate < TIER_UNOBSERVABLE ? "관측불가" : judgeRate < TIER_DELAYED ? "관측지연" : "관측가능";

  // 평소 이분이 **가장 길게** 쉬신 기간(기준선 창 안, 운영일).
  //
  // tierWindow 는 마지막으로 오신 날에서 끝나므로 **지금 진행 중인 결석은 안 들어갑니다** —
  // 자기 자신을 기준으로 재는 일이 없습니다. 공휴일·밀키트 기간은 opportunityDays 단계에서
  // 이미 빠져 있어, 연휴로 길어진 구간이 기준을 부풀리지 않습니다.
  let usualMaxGap = 0;
  {
    let run = 0;
    for (const d of tierWindow) {
      if (r.attendance[d]) {
        if (run > usualMaxGap) usualMaxGap = run;
        run = 0;
      } else run++;
    }
    if (run > usualMaxGap) usualMaxGap = run;
  }
  if (tier === "관측불가")
    return {
      bucket: "undetectable",
      // 사양 7-1: tier == 관측불가 → level = 판단보류.
      // 예전에는 "normal" 로 흘려보내 「정상」이라고 적었습니다. 판단하지 않은 것을
      // 괜찮다고 말하면, 담당자는 그분을 확인한 셈 치게 됩니다.
      level: "unknown",
      signal: "undetectable",
      baselineRate,
      habitRate,
      chanceProb: 1,
      tier,
      ...base,
      judgedDays: tierAttended,
    };

  // ── 절벽 점수: 마지막 출석 이후 결석 운영일마다 -ln(1-p) 누적(요일확률·계절 반영) ──
  // 사람이 몰린 행사일 출석은 **복귀로 보지 않습니다.**
  //
  // getConsecutiveAbsence 는 이미 그렇게 세고 있었는데(1984행) 여기만 빠져 있었습니다.
  // 그래서 석 달 끊기셨다가 초복(752명 오신 날)에 한 번 들르신 분이, 화면에는
  // "100일째 안 나오십니다"라고 적히면서 등급은 「정상」으로 나왔습니다. 한 줄 안에서
  // 모순이 보이면 담당자는 목록 전체를 버립니다. 두 곳의 규칙을 같게 맞춥니다.
  let lastIdx = -1;
  for (let i = days.length - 1; i >= 0; i--) {
    if (r.attendance[days[i]]) {
      if (CROWD_DAYS.has(days[i])) continue;
      lastIdx = i;
      break;
    }
  }
  // ★ 기준선은 **그날 시점**으로 다시 잡습니다 (구현요청서 4장 "매일, 각 회원에 대해
  //   직전 60 운영일로 계산" + 6-1 "그날의 p로 적립").
  //
  //   예전에는 오늘의 dowProb 하나를 결석한 모든 날에 소급 적용했습니다. 그런데 오늘의
  //   기준선에는 **지금 이어지고 있는 결석이 통째로 들어 있습니다.** 12일 빠지면 60일 창의
  //   1/5이 결석이라 "평소 출석률"이 90%에서 72%로 내려앉고, 그 낮아진 값으로 12일 전
  //   첫 결석까지 다시 계산합니다. 오래 안 나오실수록 하루의 무게가 가벼워지는 셈입니다.
  //
  //   실측으로 확인했습니다. 이 방식에서는 절벽점수가 아무리 높아도 15.6점이었고 즉시확인
  //   문턱 18점에 아무도 닿지 못했습니다(위기 0명). 사양 기대값은 3~5명입니다.
  //
  //   사양대로 고치면 첫 결석일은 **결석이 섞이지 않은 기준선**(90%)으로 -ln(0.10)=2.30점이
  //   붙고, 뒤로 갈수록 가벼워집니다. 무거운 날이 앞에 쌓이므로 문턱에 닿습니다.
  const dowProbAsOf = (endExclusive: number): number[] => {
    const w = days.slice(Math.max(0, endExclusive - BASELINE_DAYS), endExclusive);
    const att = [0, 0, 0, 0, 0];
    const tot = [0, 0, 0, 0, 0];
    let attended = 0;
    for (const d of w) {
      const wd = parseDateStr(d).getDay();
      if (wd < 1 || wd > 5) continue;
      tot[wd - 1]++;
      if (r.attendance[d]) {
        att[wd - 1]++;
        attended++;
      }
    }
    const br = attended / BASELINE_DAYS; // 사양과 같은 고정 분모
    return tot.map((t, i) => {
      const pp = t > 0 ? att[i] / t : br;
      return Math.min(0.995, Math.max(0.005, pp));
    });
  };

  let cliffScore = 0;
  // 결석한 날을 요일별로도 세어 둡니다. 점수에는 이미 요일이 녹아 있는데(아래 p 가
  // 그 요일의 확률입니다) **화면이 그 얘기를 한 번도 안 했습니다.** 그래서 담당자에게는
  // 요일을 안 보는 것처럼 보였습니다. 「금요일마다 오시던 분이 금요일을 세 번 건너뛰셨다」
  // 를 말하려면 횟수를 따로 들고 있어야 합니다.
  const missedByDow = [0, 0, 0, 0, 0];
  for (let i = lastIdx + 1; i < days.length; i++) {
    const d = days[i];
    if (getFestivalAdjacency(d)) continue; // 명절 전후는 판정 유예(적립 건너뜀)
    const wd = parseDateStr(d).getDay();
    if (wd < 1 || wd > 5) continue;
    const p = Math.min(seasonalP(dowProbAsOf(i)[wd - 1], d), 0.995);
    cliffScore += -Math.log(1 - p);
    missedByDow[wd - 1]++;
  }

  // ★ 「이분은 무슨 요일에 오시던 분인가」.
  //
  //   마지막으로 오신 날까지의 창에서 요일별 출석률을 봅니다. 어떤 요일은 높고 어떤
  //   요일은 거의 0인 분만 「요일 리듬이 있는 분」으로 봅니다 — 매일 고르게 오시는 분께
  //   「월화수목금에 오시던 분」이라고 적는 것은 아무 말도 안 하는 것입니다.
  //
  //   경계: 자주 오시는 요일 50% 이상, 거의 안 오시는 요일 25% 미만이 하나라도 있을 것.
  const dowAtLastVisit = dowProbAsOf(tierEnd);
  const usualDows: number[] = [];
  let hasRareDow = false;
  for (let i = 0; i < 5; i++) {
    if (dowAtLastVisit[i] >= 0.5) usualDows.push(i + 1);
    if (dowAtLastVisit[i] < 0.25) hasRareDow = true;
  }
  const dowPattern =
    usualDows.length >= 1 && usualDows.length <= 4 && hasRareDow
      ? { usual: usualDows, missed: usualDows.map((wd) => missedByDow[wd - 1]) }
      : null;

  // ── 하락 점수: 최근 15 vs 이전 45 운영일 (관측가능에서만) ──
  let declineScore = 0;
  // 게이트는 tier 와 **같은 창**을 씁니다(judgeRate = 마지막 방문일까지).
  //
  // 여기만 오늘 기준 baseRate 를 쓰고 있었습니다. 그러면 결석이 길어질수록 기준선이
  // 깎여 어느 날 문턱 아래로 떨어지고, 「📉 서서히 줄고 있는 분」 명단에서 **더
  // 나빠졌는데 사라집니다.** 평소 90% 오시던 분으로 실측 —
  //
  //   결석 40일  오늘기준선 31.7%  하락 7.83 → 명단에 있음
  //   결석 52일  오늘기준선 13.3%  하락 0.00 → **통로 자체가 닫힘**
  //
  // tier 를 마지막 방문일 기준으로 옮긴 것과 같은 이유입니다. 두 통로가 같은 창을
  // 봐야 "관측 가능한 분"의 뜻이 하나가 됩니다.
  if (judgeRate >= TIER_DELAYED && days.length >= DECLINE_SHORT + DECLINE_LONG) {
    const recent = days.slice(-DECLINE_SHORT);
    const prior = days.slice(-(DECLINE_SHORT + DECLINE_LONG), -DECLINE_SHORT);
    let a2 = 0;
    for (const d of recent) if (r.attendance[d]) a2++;
    let a1 = 0;
    for (const d of prior) if (r.attendance[d]) a1++;
    const p2 = a2 / DECLINE_SHORT;
    const p1 = a1 / DECLINE_LONG;
    const pAvg = (p1 + p2) / 2;
    const se = Math.sqrt(pAvg * (1 - pAvg) * (1 / DECLINE_SHORT + 1 / DECLINE_LONG));
    const zz = (p2 - p1) / Math.max(se, 1e-9);
    declineScore = -Math.log(Math.max(normalCdf(zz), 1e-12));
  }
  const chronic = declineScore >= DECLINE_THRESHOLD;

  // ── 등급(절벽 점수 기준) ──────────────────────────────────
  let level: RiskLevel;
  let bucket: RiskBucket;
  if (cliffScore >= LEVEL_IMMEDIATE) {
    level = "crisis"; // 🔴 긴급
    bucket = "early";
  } else if (cliffScore >= LEVEL_RECOMMEND) {
    level = "caution"; // 🟠 위기
    bucket = "early";
  } else if (cliffScore >= LEVEL_WATCH) {
    level = "concern"; // 🟢 관심
    bucket = "observe";
  } else {
    level = "normal";
    bucket = "none";
  }
  // ★ 리듬이 깨졌으면 **한 단계 올립니다.**
  //
  //   한 단계만 올리는 이유: 이건 절벽점수를 대신하는 값이 아니라 **곁에서 거드는**
  //   값입니다. 빈도로 본 위험이 낮은데 리듬만으로 🔴까지 보내면, 원래 띄엄띄엄
  //   오시던 분이 우연히 규칙적이었던 시기 하나로 위기가 됩니다.
  //
  //   이렇게 달라집니다(평소 최장 결석 기준) —
  //     매일 오시던 분(최장 1일)   4일째 → 🟡이 🔴로      ← 현장 감각과 맞습니다
  //     주 4회(최장 2일)          5일째 → 🟢이 🟡로
  //     주 3회(최장 3일)          8일째 → 🟢이 🟡로
  //     주 1회(최장 8~10일)       4일째 → 그대로 정상      ← 이분껜 흔한 일입니다
  //
  //   개인차가 문턱을 바꾸는 것이 아니라 **문턱이 사람마다 원래 다릅니다.**
  const rhythmBreak = usualMaxGap > 0 && k >= RHYTHM_MIN_DAYS && k > usualMaxGap * RHYTHM_MULT;
  if (rhythmBreak) {
    if (level === "normal") {
      level = "concern";
      bucket = "observe";
    } else if (level === "concern") {
      level = "caution";
      bucket = "early";
    } else if (level === "caution") {
      level = "crisis";
      bucket = "early";
    }
  }

  const acute = cliffScore >= LEVEL_WATCH;
  const signal: WorklistEntry["signal"] = acute ? "acute" : chronic ? "chronic" : "acute";

  const result: RiskClassification = {
    bucket,
    level,
    signal,
    baselineRate,
    habitRate,
    chanceProb: Math.exp(-cliffScore),
    cliffScore,
    declineScore,
    tier,
    judgedDays: tierAttended,
    dowPattern,
    usualMaxGap,
    rhythmBreak,
    consecutiveAbsence: k,
    recentRate: base.recentRate,
    chronic,
    acute,
  };

  // 사유 확인 안심(스누즈): early/observe였어도 그 기간엔 "확인됨"으로 빼둡니다.
  const snooze = getActiveSnooze(r.id, asOfStr);
  if (snooze && (bucket === "early" || bucket === "observe"))
    return {
      ...result,
      bucket: "acknowledged",
      // level 은 목록·KPI 가 기대하는 대로 normal 로 둡니다(오늘 연락할 분이 아닙니다).
      // 다만 **원래 등급을 함께 담아** 보냅니다 — 화면이 「정상」이라고 단언하지
      // 않도록. 가린 것과 괜찮은 것은 다릅니다.
      level: "normal",
      levelBeforeSnooze: level,
      snoozeUntil: snooze.until,
      snoozeReason: snooze.reason,
    };

  return result;
}

/**
 * 개발 모드 전용 진단 창구.
 *
 * "위기가 왜 안 뜨지?"를 추측으로 답하지 않기 위한 것입니다. 브라우저 콘솔에서
 * `__diag()` 를 부르면 점수 분포와 어디서 걸러졌는지가 한 번에 나옵니다.
 * 배포본에는 들어가지 않습니다(import.meta.env.DEV 로 막혀 있습니다).
 */
/**
 * 주별 "5일 개근 비율" — 일괄 발권 판정(사양 3장 STEP 3)이 실제로 걸리는지 보는 눈입니다.
 * 사양은 "주 이용 50명 이상 + 개근 비율 60% 이상"을 기준으로 삼았고, 실제 사례로
 * 2025-04-07~11(179명 개근, 평소 개근율 20~30%)을 들었습니다. 그 주가 이 규칙에
 * 실제로 걸리는지 숫자로 확인할 수 있어야 합니다.
 */
function topPerfectWeeks(limit = 6) {
  const active = getActiveResidents();
  const weeks = new Map<string, string[]>();
  for (const d of OPERATING_DAYS) {
    const dt = parseDateStr(d);
    const wd = dt.getDay();
    const mon = toDateStr(addDays(dt, -(wd === 0 ? 6 : wd - 1)));
    (weeks.get(mon) ?? weeks.set(mon, []).get(mon)!).push(d);
  }
  const rows: { week: string; days: number; users: number; perfect: number; ratio: number }[] = [];
  for (const [mon, ds] of weeks) {
    const seen = new Map<string, number>();
    for (const d of ds) {
      for (const r of active) if (r.attendance[d]) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
    }
    if (seen.size === 0) continue;
    let perfect = 0;
    for (const [, n] of seen) if (n >= ds.length) perfect++;
    rows.push({
      week: mon,
      days: ds.length,
      users: seen.size,
      perfect,
      ratio: Math.round((perfect / seen.size) * 1000) / 10,
    });
  }
  return rows
    .filter((r) => r.days >= 5)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, limit);
}

export function diagnoseRisk(asOfStr: string = DATA_END_STR) {
  asOfStr = clampAsOf(asOfStr);
  const active = getActiveResidents();
  const tally: Record<string, number> = {};
  const cliffs: number[] = [];
  const top: { id: string; cliff: number; base: number; absent: number; tier: string }[] = [];
  for (const r of active) {
    const c = classifyRisk(r, asOfStr);
    tally[c.bucket] = (tally[c.bucket] ?? 0) + 1;
    tally[`tier:${c.tier}`] = (tally[`tier:${c.tier}`] ?? 0) + 1;
    if (c.bucket !== "notEnough") cliffs.push(c.cliffScore);
    top.push({
      id: r.id,
      cliff: Math.round(c.cliffScore * 10) / 10,
      base: c.baselineRate,
      absent: c.consecutiveAbsence,
      tier: c.tier,
    });
  }
  top.sort((a, b) => b.cliff - a.cliff);
  cliffs.sort((a, b) => b - a);
  return {
    asOf: asOfStr,
    명부: active.length,
    운영일수: OPERATING_DAYS.length,
    판정제외일수: REDUCED_OPERATION.size,
    마지막운영일: OPERATING_DAYS[OPERATING_DAYS.length - 1],
    분류: tally,
    제외된날: getExcludedDays(),
    개근비율상위주간: topPerfectWeeks(),
    절벽점수상위20: top.slice(0, 20),
    문턱: { 관심: LEVEL_WATCH, 위기: LEVEL_RECOMMEND, 긴급: LEVEL_IMMEDIATE },
  };
}

/**
 * 목록에 붙일 **상태 표시** — 등급만으로는 사실과 다르게 보이는 경우를 메웁니다.
 *
 * 실제로 이런 화면이 나왔습니다.
 *   전○치 · 225일 연락 없음  → 등급 "정상"
 *   임○정 · 118일 연락 없음  → 등급 "정상"
 *
 * 위험도 등급(RiskLevel)에는 "판단 어려움"이 없어서, 급식으로는 판단할 수 없는 분이 전부
 * "정상"으로 표시됐습니다. 225일 연락이 안 되는 분을 정상이라고 적어두면 그 목록은
 * 아무도 믿지 않습니다. 보류·종료도 마찬가지로 어느 화면에도 나타나지 않았습니다.
 */
export interface DisplayStatus {
  label: string;
  style: string;
  /** 왜 이 표시인지 — 마우스를 올리면 보이게 */
  hint: string;
}

/**
 * 「이 어르신을 급식 기록으로 볼 수 있는가」에 한 줄로 답합니다.
 *
 * 맞돌팀·사례관리팀이 회원번호로 찾아 들어왔을 때 가장 먼저 알아야 하는 것입니다.
 * 급식을 원래 안 쓰시는 분을 조회하면 화면이 「판단 어려움」만 보여주는데, 그러면
 * **"이 도구 안 되네"** 로 읽힙니다. 안 되는 것이 아니라 **볼 자료가 없는 것**이고,
 * 그 둘은 담당자가 다음에 할 일이 완전히 다릅니다 —
 *
 *   볼 자료가 없다  → 급식 말고 다른 경로로 확인해야 합니다(방문·전화·타 기관)
 *   도구가 고장났다 → 다시는 안 씁니다
 *
 * 그래서 **왜 못 보는지와 숫자 근거**를 함께 적습니다.
 */
export interface Observability {
  /** 지금 이분을 급식 기록으로 판정하고 있나. */
  canJudge: boolean;
  /** 한 줄 결론. */
  headline: string;
  /** 숫자 근거(없으면 빈 문자열). */
  detail: string;
  /** 담당자가 다음에 할 일(판정 못 할 때만). */
  next: string;
  tone: "ok" | "warn" | "blocked";
}

export function getObservability(r: Resident, asOfStr: string = DATA_END_STR): Observability {
  asOfStr = clampAsOf(asOfStr);
  const blocking = blockingIssue(r);
  if (blocking)
    return {
      canJudge: false,
      headline: "자료가 깨져 있어 판정하지 못합니다",
      detail: `${blocking.kind} — ${blocking.detail}`,
      next: "관리자 설정 → 자료 점검에서 고쳐 주세요.",
      tone: "blocked",
    };

  const st = getMemberState(r, asOfStr);
  if (st.status === "종료")
    return {
      canJudge: false,
      headline: "사례 관리를 종료한 분입니다 — 판정하지 않습니다",
      detail: st.reason,
      next: "다시 보셔야 하면 아래 확인 기록에서 「목록으로 되돌리기」를 누르세요.",
      tone: "blocked",
    };
  if (st.status === "보류")
    return {
      canJudge: false,
      headline: "사정을 알고 있어 판정을 멈춰 둔 분입니다",
      detail: st.reason,
      next: "다시 나오시면 자동으로 풀립니다. 그때까지는 담당자가 직접 챙기셔야 합니다.",
      tone: "warn",
    };
  if (st.observeUntil)
    return {
      canJudge: false,
      headline: "다시 나오기 시작하셔서 새 리듬을 보는 기간입니다",
      detail: st.reason,
      next: `${st.observeUntil}까지는 판정하지 않습니다.`,
      tone: "warn",
    };

  const c = classifyRisk(r, asOfStr);
  if (c.bucket === "acknowledged" && c.snoozeUntil)
    return {
      canJudge: true,
      headline: `사유를 확인해 ${c.snoozeUntil}까지 안심 처리한 분입니다`,
      detail: `${c.snoozeReason || "확인 기록 참고"}${
        c.levelBeforeSnooze && c.levelBeforeSnooze !== "normal"
          ? ` · 출결만 보면 ${RISK_LABELS[c.levelBeforeSnooze]} 상태입니다(${c.consecutiveAbsence}일째)`
          : ""
      }`,
      next: `그 날까지는 목록에서 빼둡니다. 지나도 안 나오시면 자동으로 다시 올라옵니다.`,
      tone: "warn",
    };
  const days = opportunityDays(r, DATA_START_STR, asOfStr);
  if (days.length < 20)
    return {
      canJudge: false,
      headline: "아직 비교할 기록이 모자랍니다",
      detail: `판단에 쓸 급식 기록이 ${days.length}일뿐입니다 (20일 이상 필요)`,
      next: "기록이 쌓이면 자동으로 판정에 들어갑니다.",
      tone: "blocked",
    };
  if (c.consecutiveAbsence > BASELINE_DAYS)
    return {
      canJudge: false,
      headline: `${c.consecutiveAbsence}번의 운영일 동안 한 번도 안 오셨습니다`,
      detail: `기준선을 재는 ${BASELINE_DAYS} 운영일을 통째로 넘겨, 견줄 평소 리듬이 남아 있지 않습니다`,
      next: "급식 출결로 풀 단계가 아닙니다 — 방문하거나 사례관리로 넘길지 정하셔야 합니다.",
      tone: "blocked",
    };
  if (c.tier === "관측불가")
    return {
      canJudge: false,
      headline: "급식 기록만으로는 판단하기 어려운 분입니다",
      detail: `마지막으로 오신 날까지 ${BASELINE_DAYS} 운영일 중 ${c.judgedDays}일 이용 (판정 기준 ${Math.ceil(TIER_UNOBSERVABLE * BASELINE_DAYS + 0.001)}일 이상)`,
      next: "이분은 급식이 아니라 방문·전화 등 다른 경로로 확인하셔야 합니다.",
      tone: "blocked",
    };
  if (c.tier === "관측지연")
    return {
      canJudge: true,
      headline: "판정하고 있습니다 — 다만 신호가 늦게 잡힐 수 있습니다",
      detail: `마지막으로 오신 날까지 ${BASELINE_DAYS} 운영일 중 ${c.judgedDays}일 이용 · 평소 이용이 드문 편입니다`,
      next: "",
      tone: "warn",
    };
  return {
    canJudge: true,
    headline: "급식 기록으로 보고 있습니다",
    detail: `마지막으로 오신 날까지 ${BASELINE_DAYS} 운영일 중 ${c.judgedDays}일 이용 · 평소 출석률 ${c.habitRate}%`,
    next: "",
    tone: "ok",
  };
}

export function getDisplayStatus(r: Resident, asOfStr: string = DATA_END_STR): DisplayStatus {
  asOfStr = clampAsOf(asOfStr);
  // 자료가 깨진 분을 먼저 가려냅니다.
  //
  // 회원번호가 깨졌거나 이름이 비면 getActiveResidents 가 이분을 **모든 계산에서
  // 말없이 뺍니다.** 그런데 어르신 관리 표는 명부를 직접 읽어 화면에 보여주므로,
  // 한 번도 판정한 적 없는 분에게 「정상」이 찍혀 있었습니다. 판정하지 않은 것을
  // 괜찮다고 말하지 않습니다.
  const blocking = blockingIssue(r);
  if (blocking)
    return {
      label: "자료 오류",
      style: "border-red-300 bg-red-50 text-red-700",
      hint: `${blocking.kind} — ${blocking.detail}. 자료를 고쳐야 판정할 수 있습니다.`,
    };

  const state = getMemberState(r, asOfStr);
  if (state.status === "종료")
    return {
      label: "종결",
      style: "border-stone-300 bg-stone-100 text-stone-600",
      hint: state.reason || "더 이상 급식으로 볼 수 없게 된 분입니다",
    };
  if (state.status === "보류")
    return {
      label: "보류",
      style: "border-sky-300 bg-sky-50 text-sky-800",
      hint: state.reason || "사정을 확인해 판정을 잠시 멈춰 둔 분입니다",
    };
  if (state.observeUntil)
    return {
      label: "복귀 관찰",
      style: "border-violet-300 bg-violet-50 text-violet-800",
      hint: state.reason || "다시 나오기 시작하셔서 새 리듬을 보는 기간입니다",
    };

  const c = classifyRisk(r, asOfStr);
  if (c.bucket === "undetectable" || c.tier === "관측불가")
    return {
      label: "판단 어려움",
      style: "border-stone-300 bg-white text-stone-600",
      hint: "평소 이용이 월 1~2회 이하라 급식 기록만으로는 판단할 수 없습니다",
    };
  if (c.bucket === "notEnough") {
    // 「자료 부족」한 가지로 뭉치면 안 됩니다. 60 운영일 넘게 안 나오셔서 판정을 멈춘
    // 분께 "기록이 20일에 못 미칩니다"라고 적으면 완전히 틀린 안내입니다 — 그분은
    // 기록이 넘치도록 많고, 최근에 한 번도 안 오셨을 뿐입니다.
    const longGone = c.consecutiveAbsence > BASELINE_DAYS;
    return {
      label: longGone ? "판단 어려움" : "자료 부족",
      style: "border-stone-200 bg-stone-50 text-stone-500",
      hint: longGone
        ? `${c.consecutiveAbsence}번의 운영일 동안 한 번도 안 오셔서, 견줄 평소 리듬이 남아 있지 않습니다`
        : "판단에 쓸 기록이 아직 20일에 못 미칩니다",
    };
  }
  // ★ **가려지기 전 등급**을 보여줍니다.
  //
  //   회원관리 표에서 등급 필터는 getCurrentRisk(levelBeforeSnooze ?? level)로 거르는데
  //   배지만 c.level 을 썼습니다. 그래서 「긴급」으로 걸러 놓고 초록 「정상」 배지가
  //   찍혔습니다 — 한 줄 안에서 필터와 표시가 다른 말을 한 셈입니다.
  //
  //   안심 처리는 「오늘 전화할 목록에서 뺀다」는 뜻이지 「괜찮아졌다」가 아닙니다.
  //   가린 것과 괜찮은 것은 다릅니다. 대신 왜 목록에 없는지를 hint 에 적습니다.
  const shown = c.levelBeforeSnooze ?? c.level;
  return {
    label: RISK_LABELS[shown],
    style: RISK_BADGE_STYLES[shown],
    hint:
      c.levelBeforeSnooze && c.snoozeUntil
        ? `사유를 확인해 ${c.snoozeUntil}까지 목록에서 빼 두었습니다(출결만 보면 ${RISK_LABELS[c.levelBeforeSnooze]})`
        : c.tier === "관측지연"
          ? "평소 이용이 적어 감지가 늦을 수 있습니다"
          : "",
  };
}

/**
 * 판정을 멈췄을 때 쓰는 빈 목록 (구현요청서 10장 "판정 전면 중단").
 *
 * 자료가 덜 들어온 날에 계산된 명단을 그대로 보여주면 안 됩니다 — 안 들어온 분이 전부
 * 결석으로 잡혀 수십 명이 한꺼번에 위기로 뜹니다. 그런 알림을 한 번 받으면 담당자는
 * 그 뒤로 이 목록을 믿지 않습니다.
 */
export const EMPTY_WORKLIST: RiskWorklist = {
  earlyIntervention: [],
  observe: [],
  declineList: [],
  undetectable: [],
  acknowledged: [],
  reviewed: 0,
  notEnough: 0,
};

/**
 * 평소 얼마나 오시는지를 **주당 횟수**로 풀어 씁니다.
 *
 * 예전에는 40% 미만을 전부 "가끔"으로 묶었는데, 목록 8줄 중 5줄이 "가끔"이면 그 말이
 * 아무것도 구분해주지 못합니다. 담당자가 전화를 걸기 전에 알고 싶은 것은 "이분이 원래
 * 얼마나 오시던 분인가"이고, 그건 "주 2회쯤"처럼 셀 수 있는 말이어야 합니다.
 *
 * 한 주의 운영일은 5일로 봅니다(월~금).
 */
export function describeVisitFrequency(baselineRate: number): string {
  const perWeek = (baselineRate / 100) * 5;
  if (perWeek >= 4.5) return "거의 매일";
  if (perWeek >= 3.5) return "주 4회쯤";
  if (perWeek >= 2.5) return "주 3회쯤";
  if (perWeek >= 1.5) return "주 2회쯤";
  if (perWeek >= 0.8) return "주 1회쯤";
  if (perWeek >= 0.4) return "2주에 한 번쯤";
  return "한 달에 한두 번";
}

/**
 * 안 나오신 기간에 **설명이 될 만한 사정이 있었는가**.
 *
 * 이 앱에서 외부변수의 쓸모는 결석을 지우는 데 있지 않고, 결석에 **설명이 붙는지 아닌지**를
 * 가르는 데 있습니다.
 *
 *   "비도 안 왔고 행사도 없던 평범한 날부터 엿새째"   ← 설명이 없다. 이게 진짜 신호입니다
 *   "비 20mm 온 날 하루 빠지심"                       ← 설명이 된다. 한 번 더 보면 됩니다
 *
 * 지금까지는 이 값을 계산해놓고 화면 어디에도 안 썼습니다. AI가 설명 문장을 쓸 때 쓰라고
 * 여기서 한 덩이로 만들어 넘깁니다.
 *
 * 스위치를 끄면 getReferenceFactors 가 걸러내므로 여기서도 자동으로 빠집니다 — 관리자
 * 화면에서 날씨를 끄면 AI 문장에서도 날씨 이야기가 사라집니다.
 */
export function describeAbsenceContext(
  resident: Resident,
  asOfStr: string = DATA_END_STR,
): { line: string; explainedDays: number; totalDays: number } {
  // ⚠️ 자기가 받은 기준일을 넘겨야 합니다.
  //
  // 안 넘기면 `last` 가 asOfStr 보다 뒤일 수 있고, 그러면 아래 `days` 가 빈 배열이 되어
  // **"안 나오신 날이 아직 없습니다"** 가 나옵니다. 이 문장은 그대로 AI 프롬프트에
  // 들어갑니다 — 석 달째 끊기신 분을 두고 AI 에게 "결석이 없다"고 말하는 셈입니다.
  // ⚠️ 화면의 「연속결석 N일」과 **같은 규칙**으로 셉니다.
  //
  //   여기만 행사일을 복귀로 쳤습니다. 그래서 초복에 한 번 들르신 분의 화면이 —
  //
  //     연속결석 54일                              ← getConsecutiveAbsence (행사일 제외)
  //     AI: "43일간 나오지 않으셨습니다"              ← 여기 (행사일을 복귀로 셈)
  //
  //   담당자가 AI 문장을 읽고 달력에서 확인하면 숫자가 안 맞습니다. 바로 위 근거 칸이
  //   "07-15 초복에 오셨지만 복귀로 세지 않았습니다"라고 적고 있는데도요.
  const last = getLastAttendanceDate(resident, asOfStr, { skipCrowdDays: true });
  const from = last ?? resident.registeredAt;
  const days = OPERATING_DAYS.filter((d) => d > from && d <= asOfStr);
  if (days.length === 0) {
    return { line: "안 나오신 날이 아직 없습니다.", explainedDays: 0, totalDays: 0 };
  }

  // 화면에 스위치가 있는 것만 씁니다.
  //
  // 실제로 사고가 났습니다 — 장날·기초연금은 검정에서 무효로 나와 화면에서 뺐는데,
  // 데이터베이스에 저장된 스위치 값은 켜진 채로 남아 있었습니다. 그 결과 AI가
  // "장날 3일, 기초연금 지급일 1일이 있었습니다"를 근거로 써버렸습니다. 담당자는
  // 화면 어디에서도 그 변수를 본 적이 없는데 판단 문장에는 나옵니다.
  //
  // 화면에 없는 변수가 조용히 판단에 끼어드는 것이 가장 나쁩니다. 그래서 토글만 믿지
  // 않고 여기서 한 번 더 좁힙니다.
  const SHOWN: ReferenceFactorKind[] = ["badWeather", "special"];
  const reasons = new Map<string, number>();
  let explained = 0;
  for (const d of days) {
    const fs = getReferenceFactors(d).filter((f) => SHOWN.includes(f.kind));
    if (fs.length === 0) continue;
    explained++;
    for (const f of fs) reasons.set(f.label, (reasons.get(f.label) ?? 0) + 1);
  }

  if (explained === 0) {
    return {
      line: `안 나오신 운영일 ${days.length}일 — 그중 날씨·행사 등으로 설명되는 날은 0일입니다(전부 평범한 날).`,
      explainedDays: 0,
      totalDays: days.length,
    };
  }

  const detail = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, n]) => `${label} ${n}일`)
    .join(", ");
  return {
    line: `안 나오신 운영일 ${days.length}일 — 그중 ${explained}일은 사정이 있었습니다(${detail}). 나머지 ${days.length - explained}일은 평범한 날입니다.`,
    explainedDays: explained,
    totalDays: days.length,
  };
}

/**
 * 이 도구로는 볼 수 없는 분 — **직접 챙겨야 하는 명단**.
 *
 * 판정에서 빼는 것까지는 맞습니다. 근거 없는 숫자를 매기면 목록 전체를 불신하게 되니까요.
 * 그런데 **빼고 끝내면 아무도 안 보게 됩니다.** 이 앱이 막으려던 것이 바로 그것 —
 * 조용히 사라지는 분은 조용해서 안 떠오른다는 것 — 이므로, 판정에서 빠진 분일수록
 * 화면에 이름이 남아 있어야 합니다.
 *
 * 인원이 적은 두 갈래만 담습니다. 판단 어려움(평소 이용이 월 1~2회 이하)는 150명이 넘어
 * 대시보드에 올리면 정작 오늘 연락할 분이 묻히므로 통계 화면에 따로 둡니다.
 */
export interface UnanalyzableEntry {
  resident: Resident;
  reason: string;
  detail: string;
  lastVisit: string | null;
  /** 마지막 방문 이후 지난 날(달력). 자료가 성하지 않아 운영일로는 셀 수 없습니다. */
  daysSince: number | null;
}

export function getUnanalyzable(asOfStr: string = DATA_END_STR): UnanalyzableEntry[] {
  // 자료가 있는 마지막 날 이후로는 볼 수 없습니다. 조회 월의 말일이 그대로 들어오면
  // "08-31 방문 · 30일 전"처럼 아직 오지 않은 날까지 세어 버립니다.
  if (asOfStr > DATA_END_STR) asOfStr = DATA_END_STR;
  const out: UnanalyzableEntry[] = [];
  const asOf = parseDateStr(asOfStr);

  const push = (r: Resident, reason: string, detail: string) => {
    const came = Object.keys(r.attendance)
      .filter((d) => r.attendance[d] && d <= asOfStr)
      .sort();
    const last = came.length ? came[came.length - 1] : null;
    out.push({
      resident: r,
      reason,
      detail,
      lastVisit: last,
      daysSince: last
        ? Math.round((asOf.getTime() - parseDateStr(last).getTime()) / 86400000)
        : null,
    });
  };

  for (const r of residents) {
    if (r.status !== "active") continue;
    // ★ 종결한 분은 여기 두지 않습니다.
    //   「사례 관리 종료」는 확인 기록만 남기고 residents.status 는 active 그대로라,
    //   60 운영일이 지나면 「장기 미이용」으로 이 명단에 다시 떴습니다. 그래서 같은 날
    //   대시보드에서는 「⚫ 사례 관리 종료(사망·이사)」에, 통계에서는 「판정해 본 적이
    //   없는 분 — 다시 나오시면 그날부터 새로 쌓습니다」에 **동시에** 계셨습니다.
    //   배타적이어야 할 두 통입니다.
    //
    // ★ 보류·복귀관찰 중인 분도 여기 두지 않습니다.
    //   사유를 이미 확인해 잠시 빼둔 분(보류)과, 다시 나오셔서 새 리듬을 익히는 중인
    //   분(복귀관찰)은 classifyRisk 가 notEnough() 로 돌려보내며 tier 를 「관측불가」,
    //   judgedDays 를 0 으로 적습니다. 아래 ④ 가 그 tier 만 보고 담으면
    //   「60 운영일 중 0일 이용 — 급식이 아니라 방문·전화로 확인하셔야 합니다」라는
    //   **사실과 다른 사유**로 명단에 오릅니다. 어제 입원 소식을 듣고 기록한 분이
    //   「한 번도 안 오셔서 볼 수 없는 분」으로 적히는 것입니다.
    //
    //   그러면 대시보드의 「잠시 제외」 상자와 이 명단에 **동시에** 계시게 되고,
    //   정말 급식으로 볼 수 없는 분들이 그 안에 묻힙니다. 위 종결과 같은 이유로
    //   배타적이어야 할 통입니다.
    const state = getMemberState(r, asOfStr);
    if (state.status === "종료") continue;
    if (state.status !== "감시중") continue;
    if (state.observeUntil && asOfStr <= state.observeUntil) continue;
    // ① 자료가 성하지 않아 판정 자체가 불가능한 분 (회원번호·이름)
    const blocking = blockingIssue(r);
    if (blocking) {
      push(r, blocking.kind, blocking.detail);
      continue;
    }
    // ② 자료가 아직 얕아 판정을 미룬 분 (기회일 20일 미만 — 최근 등록자)
    const days = opportunityDays(r, DATA_START_STR, asOfStr);
    if (days.length < 20) {
      push(
        r,
        "자료 부족",
        `판단에 쓸 기록이 ${days.length}일뿐입니다 (20일 이상 쌓이면 자동으로 판정에 들어갑니다)`,
      );
      continue;
    }
    // ③ 기준선 창(60 운영일)을 통째로 넘겨 판정을 멈춘 분.
    //
    //    classifyRisk 의 `k > BASELINE_DAYS` 주석이 "사라지는 것이 아닙니다 — 이 명단에
    //    남습니다"라고 약속해 두었는데, 실제로는 ①②에 걸리지 않아 **여기에 없었습니다.**
    //    기회일은 넘치도록 많고 자료도 성하니까요. 53명 규모의 집단이 통계 화면의
    //    「판정해 본 적이 없는 분」에서 통째로 빠져 있었습니다.
    const k = getConsecutiveAbsence(r, asOfStr);
    if (k > BASELINE_DAYS) {
      push(
        r,
        "장기 미이용",
        `${k} 운영일 연속으로 안 나오셔서 견줄 평소 리듬이 없습니다 (다시 나오시면 그날부터 새로 쌓습니다)`,
      );
      continue;
    }
    // ④ 원래 너무 드물게 오셔서 기준선이 서지 않는 분 (tier = 관측불가).
    //
    //    ★ 이 통이 통째로 빠져 있었습니다. 60명 규모입니다.
    //      화면에는 「판단 어려움」이라고 등급이 찍히는데(classifyRisk 가 level:"unknown"
    //      을 내니까), 통계의 「판정해 본 적이 없는 분」 명단에는 없었습니다. ①②③ 어디에도
    //      안 걸리기 때문입니다 — 자료는 성하고, 기회일도 넉넉하고, 연속결석도 짧습니다.
    //      그냥 원래 한 달에 한두 번 오시는 분입니다.
    //
    //      그래서 이분들은 **아무 명단에도 없었습니다.** 위기 목록에는 판정이 안 되어
    //      안 오르고, 판정 못 한 분 명단에는 여기 안 걸려 안 오릅니다. 등급만 「판단
    //      어려움」으로 찍힌 채 어디에서도 호명되지 않습니다. 이용자 안내문이 "통계·분석
    //      화면의 별도 명단"에서 챙긴다고 적어 둔 바로 그 집단인데, 그 명단에 없었습니다.
    //
    //      급식 출결로는 이분들을 볼 수 없다는 것이 이 도구의 한계입니다. 한계인 것과
    //      명단에서 사라지는 것은 다릅니다. 볼 수 없으면 볼 수 없다고 이름을 적어 두어야
    //      기관이 다른 경로(방문·전화)로 챙길 수 있습니다.
    const c = classifyRisk(r, asOfStr);
    if (c.tier === "관측불가") {
      push(
        r,
        "이용이 너무 적음",
        `마지막으로 오신 날까지 ${BASELINE_DAYS} 운영일 중 ${c.judgedDays}일 이용 (판정 기준 ${Math.ceil(TIER_UNOBSERVABLE * BASELINE_DAYS + 0.001)}일 이상) — 급식이 아니라 방문·전화로 확인하셔야 합니다`,
      );
    }
  }

  // 오래 못 뵌 분부터. 기록이 아예 없는 분을 맨 앞에 둡니다.
  return out.sort((a, b) => (b.daysSince ?? 99999) - (a.daysSince ?? 99999));
}

/**
 * 확인 기록에 적은 말에 **부가 자료를 붙여 줍니다** (키워드화).
 *
 * 담당자가 "추석 일정으로 결석하심"이라고 적으면, 그 밑에 **실제 추석이 언제까지인지**와
 * **그 뒤 첫 운영일이 언제인지**를 붙입니다. 담당자가 달력을 따로 뒤지지 않아도 되고,
 * 복귀 예정일도 찍어주지 않아도 됩니다.
 *
 * ★ 날짜는 AI가 추측하지 않고 **공휴일 표에서 가져옵니다.**
 *   AI는 "추석이라고 말했구나"를 알아듣는 데까지고, 그게 며칠인지는 표가 압니다.
 *   추측하면 틀리고, 틀린 날짜로 목록에서 빼면 그만큼 어르신을 늦게 찾습니다.
 */
/**
 * 명절·행사 뒤 복귀를 며칠까지 기다려 줄지(운영일). 5 운영일 = 달력으로 한 주.
 *
 * 0 으로 두면 연휴 다음 날 바로 판정이 돌아옵니다 — 그게 예전 동작이었고, 아직 오실
 * 때가 아닌 분께 전화를 걸게 만들었습니다.
 */
export const RESUME_GRACE_DAYS = 5;

/**
 * 어느 날로부터 운영일 n일 뒤.
 *
 * OPERATING_DAYS 는 **자료가 있는 날**이라 미래가 없습니다. 그래서 목록에 있으면 목록을
 * 쓰고, 벗어나면 달력으로 셉니다(주말·등록된 휴관일 제외).
 */
export function addOperatingDays(fromStr: string, n: number): string {
  if (n <= 0) return fromStr;
  const idx = OPERATING_DAYS.indexOf(fromStr);
  if (idx >= 0 && idx + n < OPERATING_DAYS.length) {
    const ahead = OPERATING_DAYS.slice(idx + 1).filter((d) => !REDUCED_OPERATION.has(d));
    if (ahead.length >= n) return ahead[n - 1];
  }
  let d = parseDateStr(fromStr);
  let left = n;
  for (let i = 0; i < 60 && left > 0; i++) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const ds = toDateStr(d);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue;
    if (HOLIDAY_LABELS.has(ds)) continue;
    left--;
  }
  return toDateStr(d);
}

export interface NoteContext {
  label: string;
  detail: string;
  /** 이 자료로 제안하는 복귀 예정일(있으면) */
  suggestedResume?: string;
}

export function getNoteContext(memo: string, asOfStr: string = DATA_END_STR): NoteContext[] {
  asOfStr = clampAsOf(asOfStr);
  const out: NoteContext[] = [];
  const text = memo.trim();
  if (!text) return out;

  // ── 명절·공휴일 ──────────────────────────────────────────
  // 메모에 적힌 이름과 공휴일 표를 맞춰, 오늘 이후 가장 가까운 연휴를 찾습니다.
  const NAMES: { word: RegExp; match: RegExp }[] = [
    { word: /추석|한가위/, match: /추석/ },
    // ⚠️ "설" 한 글자만으로 매칭하면 안 됩니다.
    //
    //   "요양시설 입소하셨다고 함"  → 설날 연휴로 읽혀 복귀일 2026-02-20 이 자동 입력됨
    //   "가설 계단 공사로 못 오심"  → 같음
    //   "설득했으나 안 오신다 하심" → 같음
    //
    // 「요양시설 입소」는 이 기관에서 가장 흔한 메모입니다. 담당자가 화면에서 엉뚱한
    // "설날 연휴 기간" 패널과 7개월 전 날짜를 보게 되면 이 화면의 제안을 못 믿게 됩니다.
    { word: /설날|설\s*연휴|구정|설\s*(?:지나|쇠|전|후|이후|뒤)/, match: /설날|설 연휴/ },
    { word: /어린이날/, match: /어린이날/ },
    { word: /광복절/, match: /광복절/ },
    { word: /현충일/, match: /현충일/ },
    { word: /개천절/, match: /개천절/ },
    { word: /성탄|크리스마스/, match: /성탄|크리스마스/ },
  ];
  for (const { word, match } of NAMES) {
    if (!word.test(text)) continue;
    const days = [...HOLIDAY_LABELS.entries()]
      .filter(([d, label]) => match.test(label) && d >= asOfStr.slice(0, 4) + "-01-01")
      .map(([d]) => d)
      .sort();
    // 오늘 이후(또는 오늘이 포함된) 연휴 구간만 고릅니다.
    //
    // ⚠️ 예전에는 앞으로 올 연휴가 없으면 `days`(지나간 연휴)로 **되돌아갔습니다.**
    //    HOLIDAY_LABELS 가 그해 말까지만 있어서, 9월에 "설 쇠고 나오신다"라고 적으면
    //    다음 설(이듬해 2월)이 표에 없고 → 지난 2월이 잡혔습니다 —
    //
    //      오늘 2026-09-17 · "설 쇠고 나오신다 하심" → 복귀 예정일 **2026-02-19**
    //      "어린이날 지나고"                        → **2026-05-06**
    //      "광복절 이후 나오심"                     → **2026-08-18**
    //
    //    이 값은 fromCtx 로 흘러 「일시적사정」의 복귀일 필수 검사를 **가짜로 충족**시켜,
    //    담당자가 진짜 날짜를 적으라는 경고를 못 받습니다. 그리고 저장된 뒤에는 AI 에게
    //    "그때 2026-02-19쯤 나오신다고 하심"으로 전달됩니다 — 기록일보다 일곱 달 앞선
    //    "약속"입니다. 모르면 비워 두는 편이 낫습니다(담당자가 직접 적습니다).
    const target = days.filter((d) => d >= asOfStr);
    if (!target.length) continue;
    // 연속된 날만 한 구간으로 묶습니다.
    const start = target[0];
    const block: string[] = [start];
    for (const d of target.slice(1)) {
      const prev = parseDateStr(block[block.length - 1]);
      if ((parseDateStr(d).getTime() - prev.getTime()) / 86400000 <= 1) block.push(d);
      else break;
    }
    const end = block[block.length - 1];
    // 연휴 다음 운영일.
    //
    // OPERATING_DAYS 는 **출결 자료가 실제로 있는 날**입니다. 자료는 늘 과거까지만 있으니,
    // 앞으로 올 연휴는 이 목록에 없습니다. 그대로 두면 추석 복귀일이 빈칸이 되고, 그 자리를
    // AI 가 짐작으로 채웁니다 — 실제로 2026 추석(9/24~26) 복귀일을 10/07 로 내놨습니다.
    //
    // 그래서 목록에 없으면 달력으로 셉니다. 연휴 다음 날부터 주말·공휴일이 아닌 첫날입니다.
    const nextOperatingAfter = (from: string): string => {
      let d = parseDateStr(from);
      for (let i = 0; i < 30; i++) {
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        const ds = toDateStr(d);
        const wd = d.getDay();
        if (wd === 0 || wd === 6) continue; // 주말은 문을 닫습니다
        if (HOLIDAY_LABELS.has(ds)) continue; // 등록된 휴관일도 건너뜁니다
        return ds;
      }
      return from;
    };
    // 판정에서 빠지는 날(밀키트·오류일·일괄발권)은 복귀일로 제안하면 안 됩니다. 그날은
    // 안 오셔도 신호가 안 나고, 오셔도 출석으로 안 세집니다 — 어느 쪽으로도 알 수 없습니다.
    const firstAfter =
      OPERATING_DAYS.find((d) => d > end && !REDUCED_OPERATION.has(d)) ?? nextOperatingAfter(end);
    // ★ 연휴 **다음 날**을 복귀일로 박으면 안 됩니다.
    //
    //   "추석 지나고 나오신다"고 하셨다고 해서, 연휴 끝난 바로 다음 운영일에 안 나오시면
    //   그 다음날 위기로 다시 올라왔습니다. 현장에서 명절은 그렇게 딱 끝나지 않습니다 —
    //   자녀 집에 며칠 더 계시거나, 오가느라 지쳐 한 주 쉬시는 일이 보통입니다.
    //   담당자는 아직 전화할 때가 아닌 분께 전화를 걸게 되고, 그런 일이 몇 번 반복되면
    //   목록 전체를 안 믿게 됩니다.
    //
    //   그래서 **일주일치 여유**를 둡니다. 연휴 다음 운영일부터 RESUME_GRACE_DAYS 만큼
    //   더 기다린 날을 복귀 예정일로 제안합니다. 그때까지도 안 나오시면 그건 명절 때문이
    //   아닙니다 — 그때 올라오는 것이 맞습니다.
    const next = addOperatingDays(firstAfter, RESUME_GRACE_DAYS);
    out.push({
      label: `${HOLIDAY_LABELS.get(block[0])?.replace(/\s*\(.*\)/, "") ?? "연휴"} 기간`,
      detail: block.length > 1 ? `${start} ~ ${end} (${block.length}일간 휴관)` : `${start} (휴관)`,
      suggestedResume: next,
    });
    if (next) {
      out.push({ label: "연휴 뒤 첫 운영일", detail: next });
    }
    break;
  }

  // ── 병원·입원 ────────────────────────────────────────────
  if (/입원|수술|시술/.test(text)) {
    out.push({
      label: "의료 일정",
      detail: "입원·수술은 기간이 길어지기 쉽습니다. 퇴원 예정일을 들으셨다면 적어두세요",
    });
  }
  // ── 더위·추위 ────────────────────────────────────────────
  if (/더워|더위|폭염/.test(text)) {
    out.push({ label: "여름철", detail: "더위로 인한 미이용은 대개 한두 주 안에 돌아오십니다" });
  }
  if (/추워|추위|한파|눈길|빙판/.test(text)) {
    out.push({
      label: "겨울철",
      detail: "1월·12월·2월은 원래 출석이 낮아 판정에 계절 반영이 들어갑니다",
    });
  }
  return out;
}

/**
 * 분류에 따라 **안심 기간을 자동으로 제안**합니다.
 *
 * 담당자가 며칠을 고를지 매번 생각하지 않게 합니다. 다만 고정은 하지 않습니다 —
 * 사정은 사람마다 다르고, 마지막 판단은 담당자가 합니다.
 */
export function suggestSnoozeDays(kind: ResultKind): number {
  switch (kind) {
    case "확인불가":
      return NO_ANSWER_SNOOZE_DAYS; // 3일 — 전화를 못 받은 것뿐이라 곧 다시 봅니다
    case "위기":
      return 14; // 입원·수술은 2주쯤 뒤 경과를 봅니다
    case "일시적사정":
      return 14;
    case "일자리프로그램참여":
      return 30; // 사업 단위가 길어 한 달쯤 뒤에 봅니다
    case "이용감소":
      return 30; // 새 리듬이 자리잡는 데 시간이 걸립니다
    default:
      return 0; // 종료 계열은 기한이 의미 없습니다
  }
}

export function getRiskWorklist(asOfStr: string = DATA_END_STR): RiskWorklist {
  asOfStr = clampAsOf(asOfStr);
  // 자료가 있는 마지막 날 이후로는 볼 수 없으므로 상한을 맞춥니다. 이렇게 해야 이번 달을
  // 볼 때 getAiRiskAssessment(내부에서 DATA_END로 클램프)와 기준일이 정확히 같아집니다.
  if (asOfStr > DATA_END_STR) asOfStr = DATA_END_STR;
  const active = getActiveResidents();
  const early: WorklistEntry[] = [];
  const observe: WorklistEntry[] = [];
  const declineList: WorklistEntry[] = [];
  const undetectable: WorklistEntry[] = [];
  const acknowledged: WorklistEntry[] = [];
  let reviewed = 0;
  let notEnough = 0;

  const buildEntry = (r: Resident, c: RiskClassification): WorklistEntry => {
    const keywords: string[] = [];
    // 칩과 아래 한 줄 설명이 **같은 말**을 쓰게 합니다 — 한 줄에서 "주 2회쯤"이라 해놓고
    // 칩에는 "자주 오시던 분"이라고 적으면 어느 쪽이 맞는지 헷갈립니다.
    keywords.push(`${describeVisitFrequency(c.habitRate)} 오시던 분`);
    if (c.cliffScore >= LEVEL_IMMEDIATE) keywords.push("급격한 이탈");
    if (c.chronic) keywords.push("서서히 줄어듦");
    if (c.tier === "관측지연") keywords.push("확인이 늦어질 수 있음");
    // 절벽점수만으로는 낮은데 등급이 올라간 분은 **왜 올라왔는지**가 줄에 있어야 합니다.
    // 없으면 담당자가 "출석률도 그렇게 낮지 않은데 왜 주의지?"만 남습니다.
    if (c.rhythmBreak)
      keywords.push(`평소 최장 ${c.usualMaxGap}일 → 지금 ${c.consecutiveAbsence}일`);
    // 요일 리듬이 뚜렷한 분은 그 요일을 몇 번 건너뛰셨는지가 가장 빠른 단서입니다.
    if (c.dowPattern) {
      const dp = c.dowPattern;
      const miss = dp.usual
        .map((wd, i) => (dp.missed[i] > 0 ? `${DOW_NAMES[wd - 1]}${dp.missed[i]}` : null))
        .filter(Boolean);
      if (miss.length > 0) keywords.push(`${miss.join("·")} 건너뜀`);
    }
    // 한 줄 안에서 「99일째」와 「마지막 07-15」가 안 맞아 보이는 이유를 같은 줄에
    // 붙입니다. 목록은 keywords 만 그리므로 여기에 없으면 설명이 사라집니다.
    if (getEventOnlyVisits(r, asOfStr).length > 0) keywords.push("행사일 방문은 복귀 제외");
    const relapseCount = getRelapseCount(r, asOfStr);
    // 담당자가 목록에서 바로 알아보게 이름 옆에 붙입니다. "또"라는 한 글자가
    // 「일시적사정」을 두 번째로 듣는 순간의 무게를 다르게 만듭니다.
    if (relapseCount > 0) keywords.push(`재발 ${relapseCount + 1}회째`);
    return {
      resident: r,
      level: c.level,
      relapseCount,
      usualMaxGap: c.usualMaxGap,
      dowPattern: c.dowPattern,
      rhythmBreak: c.rhythmBreak,
      priority: c.cliffScore + relapseCount * LEVEL_WATCH,
      baselineRate: c.baselineRate,
      habitRate: c.habitRate,
      consecutiveAbsence: c.consecutiveAbsence,
      lastDate: getLastAttendanceDate(r, asOfStr),
      chanceProb: c.chanceProb,
      mealTier: r.mealTier,
      keywords: keywords.slice(0, 3),
      signal: c.signal as WorklistEntry["signal"],
      recentRate: c.recentRate,
      levelBeforeSnooze: c.levelBeforeSnooze,
    };
  };

  for (const r of active) {
    const c = classifyRisk(r, asOfStr);
    if (c.bucket === "notEnough") {
      notEnough++;
      continue;
    }
    if (c.bucket === "undetectable") {
      undetectable.push({
        ...buildEntry(r, c),
        chanceProb: 1,
        keywords: ["가끔 오심 · 출결로 판단 불가"],
        signal: "undetectable",
      });
      continue;
    }
    // 판단 대상(관측가능·지연)입니다. 신호가 없어도 검토는 한 것으로 셉니다.
    reviewed++;

    // 하락 신호는 절벽과 별개 통로 — 절벽 등급과 무관하게 월간 목록에 모읍니다.
    if (c.chronic) declineList.push({ ...buildEntry(r, c), signal: "chronic" });

    if (c.bucket === "acknowledged") {
      acknowledged.push({
        ...buildEntry(r, c),
        snoozeUntil: c.snoozeUntil,
        snoozeReason: c.snoozeReason,
      });
    } else if (c.bucket === "early") {
      early.push(buildEntry(r, c));
    } else if (c.bucket === "observe") {
      observe.push(buildEntry(r, c));
    }
    // bucket === "none" → 정상, 목록에 없음
  }

  const vuln = (t: Resident["mealTier"]) => (t === "무료급식" ? 2 : t === "감면" ? 1 : 0);
  // 메인 대시보드: 절벽 점수(=우연일 확률 작을수록) 큰 순 → 취약계층 → 평소 자주 오신 순.
  // 절벽점수에 재발 가산을 얹은 값으로 세웁니다(priority 주석 참고).
  // chanceProb 오름차순은 절벽점수 내림차순과 같은 말이었는데, 재발을 얹으려면
  // 점수 쪽을 직접 봐야 합니다.
  const byCliff = (a: WorklistEntry, b: WorklistEntry) =>
    b.priority - a.priority ||
    vuln(b.mealTier) - vuln(a.mealTier) ||
    b.baselineRate - a.baselineRate;
  early.sort(byCliff);
  // 오래 안 나오신 분은 **더 오래된 분부터**. 여기서는 점수가 아니라 방치된 기간이
  observe.sort(byCliff);
  // 하락 목록: 평소 자주 오시던 분부터.
  declineList.sort((a, b) => b.baselineRate - a.baselineRate || a.recentRate - b.recentRate);
  undetectable.sort((a, b) => (a.lastDate ?? "").localeCompare(b.lastDate ?? ""));
  acknowledged.sort((a, b) => (a.snoozeUntil ?? "").localeCompare(b.snoozeUntil ?? ""));
  return {
    earlyIntervention: early,
    observe,
    declineList,
    undetectable,
    acknowledged,
    reviewed,
    notEnough,
  };
}

// ── 공급 실패 방어 (구현요청서 10장) ───────────────────────────
// 추출이 하루 실패하면 전원이 결석 처리되어 수백 명이 동시에 위기로 뜹니다. 그날 이용 인원이
// 평소(직전 20 운영일 중앙값)보다 뚝 떨어지면, 판정을 믿지 말라고 알립니다.
//   · 30% 미만 → 판정 중단(전날 목록 유지, "데이터 확인 중" 배너)
//   · 60% 미만 → 판정하되 경고(실제 휴관·행사·폭설일 수 있어 사람이 확인)
// "데이터 없는 날 ≠ 결석"은 이미 '오신 날만 운영일'로 설계돼 자동 충족됩니다(그날은 운영일 아님).
const FEED_BLOCK_RATIO = 0.3;
const FEED_WARN_RATIO = 0.6;
const FEED_REF_DAYS = 20;

export interface InputGuardStatus {
  status: "ok" | "warn" | "block";
  date: string | null;
  todayCount: number;
  refMedian: number;
  ratio: number; // todayCount / refMedian
}

/** 알림 급증 차단 배수 (구현요청서 12장 SURGE_MULTIPLIER). */
const SURGE_MULTIPLIER = 3.0;
/** 신규 진입 평균을 재는 창. 사양 10장 "직전 4주" = 운영일 20일. */
const GUARD_WINDOW_DAYS = 20;
/**
 * 이 인원에 못 미치면 몇 배가 됐든 막지 않습니다.
 *
 * 배수만으로 판단하면 조용한 기관에서 도구가 못 쓰게 됩니다. 실제로 그랬습니다 —
 * 지난 4주 평균이 0.3명인 곳에서 **어르신 두 분**이 새로 올라오자 "평소의 6.7배"가 되어
 * 명단 전체가 비워졌습니다. 두 분은 대량 오알림이 아니라 그냥 그날의 일입니다.
 *
 * 사양 10장이 막으려는 것은 "정제가 어긋나 수십 명이 한꺼번에 뜨는 날"입니다. 그러니
 * 배수 앞에 **절대 인원**을 세워 둡니다. 400명 명부에서 하루 10명이 새로 올라오는 것은
 * 평상시에 일어나지 않습니다.
 */
const GUARD_MIN_NEW = 10;

export interface OutputGuardStatus {
  status: "ok" | "hold";
  todayNew: number;
  recentAvg: number;
}

/**
 * 결과 방어 (구현요청서 10장 guard_output).
 *
 * 신규 진입이 평소의 3배를 넘으면 무언가 잘못된 것입니다 — 정제가 어긋났거나 자료가
 * 절반만 들어왔거나. 그대로 내보내면 담당자가 수십 명 명단을 받고 그 뒤로 이 도구를
 * 믿지 않습니다. **잘못된 대량 알림은 회복되지 않습니다.**
 */
export function getOutputGuardStatus(asOfStr: string = DATA_END_STR): OutputGuardStatus {
  asOfStr = clampAsOf(asOfStr);
  const opDays = OPERATING_DAYS.filter((d) => d <= asOfStr);
  // 4주치를 비교하려면 그 앞 하루가 더 필요합니다(첫날의 "신규"를 재려면 전날이 있어야 함).
  if (opDays.length < GUARD_WINDOW_DAYS + 2) return { status: "ok", todayNew: 0, recentAvg: 0 };

  // 같은 날을 여러 번 세지 않게 기억해 둡니다.
  //
  // countEarlyAt 한 번이 명부 전원(400여 명)에 대해 classifyRisk 를 돌립니다. 창을 4일에서
  // 20 운영일로 넓히면서 캐시가 없으면 같은 날을 두 번씩 계산하게 됩니다.
  const cache = new Map<string, number>();
  const countEarlyAt = (dayStr: string) => {
    const hit = cache.get(dayStr);
    if (hit !== undefined) return hit;
    let n = 0;
    for (const r of getActiveResidents()) {
      if (classifyRisk(r, dayStr).bucket === "early") n++;
    }
    cache.set(dayStr, n);
    return n;
  };

  // 오늘 새로 들어온 인원 = 오늘 명단 − 직전 운영일 명단. 음수면 0으로 봅니다.
  const today = opDays[opDays.length - 1];
  const prev = opDays[opDays.length - 2];
  const todayNew = Math.max(0, countEarlyAt(today) - countEarlyAt(prev));

  // 직전 4주(20 운영일)의 신규 진입 평균.
  //
  // 사양 10장은 "직전 4주 평균"입니다. 예전에는 4 **일**만 봤는데, 나흘은 우연히 조용한
  // 주가 끼면 평균이 0에 가까워져 정상적인 하루도 3배를 넘깁니다. 반대로 나흘 내내 많았던
  // 뒤에는 진짜 폭증도 안 걸립니다.
  const deltas: number[] = [];
  for (let i = opDays.length - 2; i >= Math.max(1, opDays.length - 1 - GUARD_WINDOW_DAYS); i--) {
    deltas.push(Math.max(0, countEarlyAt(opDays[i]) - countEarlyAt(opDays[i - 1])));
  }
  const recentAvg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;

  // 두 관문을 **모두** 지나야 막습니다 — 절대 인원(대량인가)과 배수(평소와 다른가).
  const status =
    todayNew >= GUARD_MIN_NEW && recentAvg > 0 && todayNew > recentAvg * SURGE_MULTIPLIER
      ? "hold"
      : "ok";
  return { status, todayNew, recentAvg: Math.round(recentAvg * 10) / 10 };
}

/**
 * 기준선 하향 이력 (구현요청서 9-5).
 *
 * 한 번의 하락은 사정이 있을 수 있지만, 반복되는 하락은 쇠약의 궤적입니다.
 * **이건 절벽 점수로는 잡히지 않습니다** — 매번 조금씩 줄기만 해서 끊긴 적이 없으니까요.
 */
export function getRepeatedDowngrades(asOfStr: string = DATA_END_STR): {
  resident: Resident;
  count: number;
}[] {
  asOfStr = clampAsOf(asOfStr);
  const sixMonthsAgo = toDateStr(addDays(parseDateStr(asOfStr), -182));
  const out: { resident: Resident; count: number }[] = [];
  for (const r of getActiveResidents()) {
    const count = FOLLOWUPS.filter(
      (f) =>
        f.residentId === r.id &&
        f.resultKind === "이용감소" &&
        f.checkedAt >= sixMonthsAgo &&
        f.checkedAt <= followupCutoff(asOfStr),
    ).length;
    if (count >= 2) out.push({ resident: r, count });
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * 약속한 복귀일이 지났는데 아직 안 나오시는 분 (구현요청서 9-4).
 *
 * "추석 이후 나올 예정"이라 하셨는데 그날이 지나도 안 나오시면 **그게 진짜 신호입니다.**
 * 담당자가 달력에 적어두고 기억할 필요가 없게 만드는 것이 이 목록의 목적입니다.
 *
 * 예전에는 getMemberState 가 resumeOverdue 플래그만 세우고 **아무도 그 값을 읽지 않았습니다.**
 * 게다가 그 사이 긴 결석으로 기준선이 무너져 관측불가로 떨어지면, 약속을 어긴 바로 그분이
 * 가장 조용한 "판단 어려움" 명단으로 갔습니다. 그래서 점수와 무관하게 따로 올립니다.
 */
export function getResumeOverdue(asOfStr: string = DATA_END_STR): {
  resident: Resident;
  promised: string;
  reason: string;
}[] {
  asOfStr = clampAsOf(asOfStr);
  const out: { resident: Resident; promised: string; reason: string }[] = [];
  for (const r of getActiveResidents()) {
    const st = getMemberState(r, asOfStr);
    if (!st.resumeOverdue) continue;
    // ⚠️ 최신 기록을 **여기서 다시 고르지 않습니다.**
    //
    //    예전에는 같은 필터를 또 돌렸는데, 정렬에 id 타이브레이크가 없어서 같은 날
    //    기록이 둘이면 getMemberState 와 다른 건을 집었습니다. 판단과 표시가 서로 다른
    //    기록을 보고 있었습니다. 판단에 쓴 값을 그대로 받아 씁니다.
    out.push({ resident: r, promised: st.promised ?? "", reason: st.reason });
  }
  return out.sort((a, b) => a.promised.localeCompare(b.promised));
}

/**
 * 연락이 계속 안 되는 분 (구현요청서 9-2, UNREACHABLE_ESCALATE).
 *
 * 확인 불가가 3회 쌓이면 전화로는 안 됩니다. 방문해야 합니다.
 * 실제 확인 27명 중 8명이 연락 불가였고, 97세 독거 어르신도 그중 한 분이었습니다.
 */
export function getVisitNeeded(asOfStr: string = DATA_END_STR): {
  resident: Resident;
  tries: number;
}[] {
  asOfStr = clampAsOf(asOfStr);
  const out: { resident: Resident; tries: number }[] = [];
  for (const r of getActiveResidents()) {
    const st = getMemberState(r, asOfStr);
    // 종결·보류하신 분은 뺍니다.
    //
    // 종료 분기가 unreachableStreak 를 그대로 물고 나오기 때문에, 확인불가 3회를 적은
    // 뒤 종결 처리된 어르신이 「⚫ 사례 관리 종료」와 「🚪 방문 확인이 필요합니다」에
    // **동시에** 떴습니다. 담당자가 돌아가신 분 댁으로 방문을 나갑니다.
    if (st.status !== "감시중") continue;
    if (st.unreachableStreak >= UNREACHABLE_ESCALATE) {
      out.push({ resident: r, tries: st.unreachableStreak });
    }
  }
  return out.sort((a, b) => b.tries - a.tries);
}

export function getInputGuardStatus(asOfStr: string = DATA_END_STR): InputGuardStatus {
  asOfStr = clampAsOf(asOfStr);
  if (asOfStr > DATA_END_STR) asOfStr = DATA_END_STR;
  const active = getActiveResidents();
  const opDays = OPERATING_DAYS.filter((d) => d <= asOfStr && !REDUCED_OPERATION.has(d));
  if (opDays.length === 0)
    return { status: "ok", date: null, todayCount: 0, refMedian: 0, ratio: 1 };
  const countOn = (d: string) => {
    let n = 0;
    for (const r of active) if (r.attendance[d]) n++;
    return n;
  };
  const today = opDays[opDays.length - 1];
  const todayCount = countOn(today);
  const refCounts = opDays
    .slice(-1 - FEED_REF_DAYS, -1)
    .map(countOn)
    .sort((a, b) => a - b);
  if (refCounts.length < 5)
    return { status: "ok", date: today, todayCount, refMedian: 0, ratio: 1 };
  const mid = Math.floor(refCounts.length / 2);
  const refMedian =
    refCounts.length % 2 ? refCounts[mid] : (refCounts[mid - 1] + refCounts[mid]) / 2;
  const ratio = refMedian > 0 ? todayCount / refMedian : 1;
  const status = ratio < FEED_BLOCK_RATIO ? "block" : ratio < FEED_WARN_RATIO ? "warn" : "ok";
  return { status, date: today, todayCount, refMedian: Math.round(refMedian), ratio };
}

/**
 * 자료 최신성 — "마지막으로 자료가 들어온 게 언제인가".
 *
 * 앱이 보는 '오늘'은 자료의 마지막 날이라, 자료가 몇 주째 안 들어와도 화면은 멀쩡해 보입니다.
 * 그래서 **실제 달력 날짜**와 비교해 며칠째 자료가 없는지 따로 알려줘야 합니다. 급식은 평일에
 * 이뤄지므로 주말은 세지 않고, 최근 평일들이 각각 자료가 있는지를 네모로 보여줍니다.
 */
export interface DataFreshness {
  /** 자료가 있는 마지막 날 */
  lastDataDate: string | null;
  /** 실제 오늘과의 간격(달력일) */
  gapDays: number;
  /** 자료가 없는 평일이 며칠째 이어지는지 */
  missingWeekdays: number;
  status: "ok" | "warn" | "stale";
  /** 최근 평일 목록(오래된 것 → 최신). 네모 한 칸이 하루입니다. */
  days: { date: string; hasData: boolean; excluded: boolean }[];
  /** 자료는 있으나 '듬성듬성한 시기'로 판정돼 분석에서 빠진 평일 수 */
  excludedDays: number;
}

/** 며칠째 자료가 없으면 주의/경고인지. 급식은 평일 기준이라 평일 수로 셉니다. */
const FRESH_WARN_WEEKDAYS = 3;
const FRESH_STALE_WEEKDAYS = 7;

export function getDataFreshness(recentWeekdays = 20, now: Date = new Date()): DataFreshness {
  const days: { date: string; hasData: boolean; excluded: boolean }[] = [];
  const cur = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // 오늘부터 거슬러 올라가며 평일만 모읍니다(주말은 급식을 하지 않으므로 셈에서 뺍니다).
  while (days.length < recentWeekdays) {
    const wd = cur.getDay();
    if (wd >= 1 && wd <= 5) {
      const ds = toDateStr(cur);
      // 자료는 있는데 분석에서 빠지는 날이 있습니다 — 앞뒤 2주 운영일이 너무 적어
      // '평소와 다른 운영 시기'로 본 날(REDUCED_OPERATION)과 공휴일·이상일입니다.
      // 이걸 표시하지 않으면 "자료를 넣었는데 왜 안 바뀌지?"가 됩니다.
      const has = OPERATING_DAY_SET.has(ds);
      const excluded = has && (REDUCED_OPERATION.has(ds) || EXTERNALLY_EXPLAINED_DATES.has(ds));
      days.push({ date: ds, hasData: has, excluded });
    }
    cur.setDate(cur.getDate() - 1);
    // 자료 시작 이전까지 내려가면 멈춥니다.
    if (toDateStr(cur) < DATA_START_STR) break;
  }
  days.reverse();

  // 최신 쪽에서부터 자료가 없는 평일이 몇 개 이어지는지.
  //
  // 공휴일은 세지 않습니다. 기관이 문을 닫은 날에는 당연히 자료가 없는데 그걸 "안 들어왔다"로
  // 세면, 설·추석 연휴만 지나도 "평일 3일째 자료가 들어오지 않았습니다" 경고가 뜹니다.
  // 대체공휴일까지 붙는 해에는 빨간 "자료 밀림"까지 갑니다. 틀린 경고가 몇 번 뜨면 담당자는
  // 그 뒤로 이 경고를 읽지 않게 됩니다 — 정작 진짜로 밀렸을 때 놓칩니다.
  let missingWeekdays = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].hasData) break;
    if (HOLIDAY_LABELS.has(days[i].date)) continue;
    missingWeekdays++;
  }

  const lastDataDate = DATA_END_STR || null;
  let gapDays = 0;
  if (lastDataDate) {
    const last = parseDateStr(lastDataDate);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    gapDays = Math.max(0, Math.round((today.getTime() - last.getTime()) / 86400000));
  }

  const status =
    missingWeekdays >= FRESH_STALE_WEEKDAYS
      ? "stale"
      : missingWeekdays >= FRESH_WARN_WEEKDAYS
        ? "warn"
        : "ok";

  const excludedDays = days.filter((d) => d.excluded).length;
  return { lastDataDate, gapDays, missingWeekdays, status, days, excludedDays };
}

/**
 * 겨울(1월·12·2월)이 실제로 출석을 낮추는지 — **우리 자료로 잰 값**.
 *
 * 다섯 참고 변수가 전부 무효로 판정된 가운데 **유일하게 살아남은 변수**입니다. 그래서 이것만
 * 계절 반영 계수로 판정에 반영하고 있습니다. 화면에 다른 변수들과 나란히 놓아야 "무엇을 쓰고
 * 무엇을 안 쓰는지"가 한눈에 설명됩니다.
 */
/**
 * ⚠️ 이 자료로는 겨울 효과를 잴 수 없습니다. 화면에 쓰지 않습니다.
 *
 * 남아 있는 겨울 운영일이 2025년 1~2월뿐입니다 — 그 뒤 겨울(2025-12 ~ 2026-03-10)은
 * 리모델링 밀키트 기간이라 정제 단계에서 빠집니다. 그런데 2025년 초는 명부가 지금보다
 * 훨씬 작아서 출석률이 구조적으로 높게 나옵니다. 실제로 재보면 겨울이 **+15.7%p 더 높게**
 * 나오는데, 이건 계절이 아니라 **명부가 커진 것**을 재고 있는 것입니다.
 *
 * 그래서 겨울 계절 반영(1월 ×0.82, 12·2월 ×0.87)은 이 화면의 표가 아니라 4년치 검증
 * 결과를 근거로 씁니다. 함수는 자료가 한 해 더 쌓이면 다시 쓸 수 있게 남겨 둡니다.
 */
export function getSeasonalImpact(): {
  daysWith: number;
  daysWithout: number;
  rateWith: number;
  rateWithout: number;
  diff: number;
} {
  const active = getActiveResidents();
  const empty = { daysWith: 0, daysWithout: 0, rateWith: 0, rateWithout: 0, diff: 0 };
  if (!active.length) return empty;

  const winter: number[] = [];
  const rest: number[] = [];
  for (const ds of OPERATING_DAYS) {
    if (REDUCED_OPERATION.has(ds) || HOLIDAY_LABELS.has(ds)) continue;
    let present = 0;
    let counted = 0;
    for (const r of active) {
      if (r.registeredAt > ds) continue;
      counted++;
      if (r.attendance[ds]) present++;
    }
    if (!counted) continue;
    const rate = (present / counted) * 100;
    const m = Number(ds.slice(5, 7));
    if (m === 1 || m === 12 || m === 2) winter.push(rate);
    else rest.push(rate);
  }
  if (!winter.length || !rest.length) return empty;

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const r1 = Math.round(mean(winter) * 10) / 10;
  const r0 = Math.round(mean(rest) * 10) / 10;
  return {
    daysWith: winter.length,
    daysWithout: rest.length,
    rateWith: r1,
    rateWithout: r0,
    diff: Math.round((r1 - r0) * 10) / 10,
  };
}

export function getFactorImpact(): FactorImpact[] {
  // 화면에 나오는 순서. 근거가 확실한 것부터 둡니다.
  const kinds: ReferenceFactorKind[] = [
    "special",
    "badWeather",
    "market",
    "holidayAdjacent",
    "pension",
  ];

  // 자료가 없어도 네 줄은 항상 돌려줍니다. 화면에서 이 줄마다 켜기/끄기 스위치가 붙기 때문에,
  // 자료가 없을 때 줄을 빼버리면 스위치도 함께 사라져 설정을 아예 바꿀 수 없게 됩니다.
  const empty = (kind: ReferenceFactorKind): FactorImpact => ({
    kind,
    name: FACTOR_META[kind].name,
    evidence: FACTOR_META[kind].evidence,
    color: FACTOR_META[kind].color,
    daysWith: 0,
    daysWithout: 0,
    rateWith: 0,
    rateWithout: 0,
    diff: 0,
  });

  const active = getActiveResidents();
  if (!active.length) return kinds.map(empty);

  // 운영일별 출석률을 먼저 한 번만 구합니다.
  const dayRates: { date: string; rate: number; kinds: Set<ReferenceFactorKind> }[] = [];
  let cursor = new Date(DATA_START);
  while (cursor <= DATA_END_DATE) {
    const dateStr = toDateStr(cursor);
    if (!isWeekend(cursor) && !HOLIDAY_LABELS.has(dateStr)) {
      // 분모는 **그날 등록돼 있던 분**입니다. 지금 명부 전체로 나누면 명부가 커진 만큼
      // 예전 날의 출석률이 낮게 찍혀, 변수 효과가 아니라 명부 증가를 재게 됩니다.
      let present = 0;
      let counted = 0;
      for (const r of active) {
        if (r.registeredAt > dateStr) continue;
        counted++;
        if (r.attendance[dateStr]) present++;
      }
      if (!counted) {
        cursor = addDays(cursor, 1);
        continue;
      }
      dayRates.push({
        date: dateStr,
        rate: (present / counted) * 100,
        // ★ 켜고 끄기와 **무관하게** 셉니다.
        //   이 표는 화면 표시가 아니라 **검증 기록**입니다. 꺼둔 변수야말로 "왜 껐는지"를
        //   숫자로 보여줘야 하는데, getReferenceFactors 는 꺼진 변수를 빼버려 해당 일수가
        //   0이 되고 "자료 부족"으로 표시됐습니다. 그러면 검증한 적이 없는 것처럼 보입니다.
        kinds: new Set(detectReferenceFactors(dateStr).map((f) => f.kind)),
      });
    }
    cursor = addDays(cursor, 1);
  }
  if (!dayRates.length) return kinds.map(empty);

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const round1 = (n: number) => Math.round(n * 10) / 10;

  return kinds.map((kind) => {
    const withRates = dayRates.filter((d) => d.kinds.has(kind)).map((d) => d.rate);
    const withoutRates = dayRates.filter((d) => !d.kinds.has(kind)).map((d) => d.rate);
    const rateWith = mean(withRates);
    const rateWithout = mean(withoutRates);
    return {
      kind,
      name: FACTOR_META[kind].name,
      evidence: FACTOR_META[kind].evidence,
      color: FACTOR_META[kind].color,
      daysWith: withRates.length,
      daysWithout: withoutRates.length,
      rateWith: round1(rateWith),
      rateWithout: round1(rateWithout),
      // 한쪽 표본이 없으면 비교가 성립하지 않으므로 0으로 둡니다(화면에서 "자료 부족"으로 표시).
      diff: withRates.length && withoutRates.length ? round1(rateWith - rateWithout) : 0,
    };
  });
}

export interface AtRiskEntry {
  resident: Resident;
  rate: number;
  present: number;
  total: number;
  consecutiveAbsence: number;
}

export function getAtRiskForMonth(year: number, month: number): AtRiskEntry[] {
  const lastDay = new Date(year, month, 0).getDate();
  const monthEnd = new Date(year, month - 1, lastDay);
  const asOf = toDateStr(monthEnd > DATA_END_DATE ? DATA_END_DATE : monthEnd);
  const entries: AtRiskEntry[] = [];
  for (const r of getActiveResidents()) {
    const stats = getMonthlyStats(r, year, month);
    if (stats.total === 0) continue;
    // 등급 계산과 같은 기준을 씁니다. 예전에는 여기서만 "출석률 70% 미만"이라는 별도
    // 기준을 썼는데, 실제 자료에서는 그 선에 2,000명 넘게 걸립니다 — 평소에 주 한 번
    // 오시는 분이 대부분이라 70%는 애초에 도달할 수 없는 숫자였습니다.
    const assessment = getAiRiskAssessment(r, monthEnd);
    if (assessment.level === "crisis" || assessment.level === "caution") {
      entries.push({
        resident: r,
        rate: stats.rate,
        present: stats.present,
        total: stats.total,
        consecutiveAbsence: getConsecutiveAbsence(r, asOf),
      });
    }
  }
  entries.sort((a, b) => a.rate - b.rate || b.consecutiveAbsence - a.consecutiveAbsence);
  return entries;
}

export function predictMealCount(targetDateStr: string): number {
  const active = getActiveResidents();
  const target = parseDateStr(targetDateStr);
  if (isWeekend(target)) return 0;
  const weekday = target.getDay();
  const samples: number[] = [];
  let cursor = addDays(target, -1);
  while (samples.length < 4 && cursor >= DATA_START) {
    if (cursor.getDay() === weekday) {
      const ds = toDateStr(cursor);
      if (ds <= DATA_END_STR) {
        let count = 0;
        for (const r of active) if (r.attendance[ds]) count++;
        samples.push(count);
      }
    }
    cursor = addDays(cursor, -1);
  }
  if (!samples.length) return Math.round(active.length * 0.7);
  return Math.round(samples.reduce((s, v) => s + v, 0) / samples.length);
}

// ── 어르신 상세 - 월별 출결 달력 ────────────────────────────────
// (기준선 창과 무관합니다. 화면이 보여주는 달 수는 상세 화면이 정합니다 — 기본 여섯 달.)

export type ResidentDayStatus = "present" | "absent" | "none";

export interface ResidentCalendarMonth {
  year: number;
  month: number;
  label: string;
  days: { day: number; status: ResidentDayStatus }[];
  presentCount: number;
  totalCount: number;
  rate: number;
}

/**
 * 개인 출석 달력. fromStr ~ toStr 구간의 모든 달을 돌려줍니다.
 *
 * 예전에는 "오늘로부터 최근 N일"만 봤는데, 그러면 2025년부터 오신 분의 지난 기록이 화면에서
 * 사라졌습니다. 이제 시작·끝 날짜를 직접 받아, 첫 기록부터 선택한 시점까지 전부 보여줍니다.
 */
export function getResidentCalendarMonths(
  resident: Resident,
  fromStr: string = getFirstAttendanceDate(resident),
  toStr: string = DATA_END_STR,
): ResidentCalendarMonth[] {
  const rangeStart = clampToRange(parseDateStr(fromStr));
  const rangeEnd = clampToRange(parseDateStr(toStr));
  // 비율을 내는 분모는 위험도 계산과 **똑같아야** 합니다.
  //
  // 운영일만 보고 세면 화면 위아래가 어긋납니다. 실제로 2026년 9월은 자료가 10일부터라
  // 운영 방식이 달랐던 시기로 분석에서 빠지는데, 달력만 따로 세면 위에는 "9월 출석률 0%",
  // 달력에는 "1/3 · 33.3%"가 동시에 뜹니다. 같은 화면에서 같은 달의 숫자가 둘이면 담당자는
  // 어느 쪽도 믿지 않게 됩니다.
  const opportunity = new Set(
    opportunityDays(resident, toDateStr(rangeStart), toDateStr(rangeEnd)),
  );
  const months: ResidentCalendarMonth[] = [];
  let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  const lastMonthStart = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1);
  while (cursor <= lastMonthStart) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;
    const daysInMonth = new Date(year, month, 0).getDate();
    const days: { day: number; status: ResidentDayStatus }[] = [];
    let present = 0;
    let total = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
      const dateObj = parseDateStr(dateStr);
      let status: ResidentDayStatus = "none";
      // 결석은 기록이 없습니다. 예전에는 `attendance[날짜] !== undefined`를 조건으로 삼아
      // **오신 날만** 셌고, 그래서 빨간 "결석" 칸이 한 번도 뜨지 않고 출석률이 누구나
      // 100%로 나왔습니다. 운영일인데 기록이 없으면 결석입니다.
      const inRange = dateObj >= rangeStart && dateObj <= rangeEnd;
      if (inRange && opportunity.has(dateStr)) {
        const came = !!resident.attendance[dateStr];
        status = came ? "present" : "absent";
        total++;
        if (came) present++;
      } else if (inRange && resident.attendance[dateStr]) {
        // 판단에서 빠진 날(공휴일·휴관·운영 방식이 달랐던 시기)에 기록이 남아 있으면 오신
        // 것은 오신 것이므로 초록으로 보여주되, 비율에는 넣지 않습니다.
        status = "present";
      }
      days.push({ day, status });
    }
    months.push({
      year,
      month,
      label: `${year}년 ${month}월`,
      days,
      presentCount: present,
      totalCount: total,
      rate: total ? Math.round((present / total) * 1000) / 10 : 0,
    });
    cursor = new Date(year, month, 1);
  }
  return months;
}

// ── 기간별 분석 ──────────────────────────────────────────────

export type PeriodKey =
  | { kind: "month"; year: number; month: number }
  | { kind: "quarter"; year: number; quarter: 1 | 2 | 3 | 4 }
  | { kind: "half"; year: number; half: 1 | 2 }
  | { kind: "year"; year: number };

export type PeriodKind = PeriodKey["kind"];

function periodRange(key: PeriodKey): { start: Date; end: Date; label: string } {
  if (key.kind === "month") {
    return {
      start: new Date(key.year, key.month - 1, 1),
      end: new Date(key.year, key.month, 0),
      label: `${key.year}년 ${key.month}월`,
    };
  }
  if (key.kind === "quarter") {
    const startMonth = (key.quarter - 1) * 3;
    return {
      start: new Date(key.year, startMonth, 1),
      end: new Date(key.year, startMonth + 3, 0),
      label: `${key.year}년 ${key.quarter}분기`,
    };
  }
  if (key.kind === "half") {
    const startMonth = key.half === 1 ? 0 : 6;
    return {
      start: new Date(key.year, startMonth, 1),
      end: new Date(key.year, startMonth + 6, 0),
      label: `${key.year}년 ${key.half === 1 ? "상반기" : "하반기"}`,
    };
  }
  return {
    start: new Date(key.year, 0, 1),
    end: new Date(key.year, 11, 31),
    label: `${key.year}년 전체`,
  };
}

export interface PeriodChartPoint {
  label: string;
  value: number;
}

export interface PeriodResidentStat {
  resident: Resident;
  present: number;
  total: number;
  absentDays: number;
  rate: number;
}

export interface PeriodStats {
  label: string;
  operatingDays: number;
  totalMeals: number;
  avgAttendance: number;
  maxDay: { date: string; count: number } | null;
  minDay: { date: string; count: number } | null;
  chart: PeriodChartPoint[];
  perfectAttendanceTop10: PeriodResidentStat[];
  mostAbsentTop10: PeriodResidentStat[];
}

export function getPeriodStats(key: PeriodKey): PeriodStats {
  const active = getActiveResidents();
  const { start, end, label } = periodRange(key);
  const rangeStart = start < DATA_START ? DATA_START : start;
  const rangeEnd = end > DATA_END_DATE ? DATA_END_DATE : end;

  // 운영일만 셉니다.
  //
  // 예전에는 "주말이 아닌 날"을 전부 넣었습니다. 그러면 공휴일과 **아직 자료를 넣지 않은
  // 날**이 "출석 0명인 날"로 분모에 들어가 평균이 내려앉습니다. 9월 1~9일 자료가 없던
  // 동안 9월 막대가 실제의 절반으로 찍힌 것이 이 때문입니다. 같은 화면의 클릭 상세는
  // 운영일 기준이라 분모가 서로 달랐습니다.
  const dailyCounts: { date: string; count: number }[] = [];
  if (rangeStart <= rangeEnd) {
    const fromStr = toDateStr(rangeStart);
    const toStr = toDateStr(rangeEnd);
    for (const ds of OPERATING_DAYS) {
      if (ds < fromStr || ds > toStr) continue;
      // 판정에서 빠지는 날은 그래프에서도 빼야 합니다.
      //
      // 예전에는 운영일이기만 하면 다 넣었습니다. 그래서 리모델링 밀키트 기간(주 1회 배부)이
      // 실적처럼 그려졌습니다 — 2026년 2월 그래프는 "평균 80명"인데 그 점을 클릭하면
      // "400명 전원 0회"가 나왔습니다. 같은 화면에서 그래프와 상세가 다른 말을 했습니다.
      // 상세(getMonthlyStats)가 쓰는 opportunityDays 와 같은 기준으로 맞춥니다.
      if (REDUCED_OPERATION.has(ds) || EXTERNALLY_EXPLAINED_DATES.has(ds)) continue;
      let count = 0;
      for (const r of active) if (r.attendance[ds]) count++;
      dailyCounts.push({ date: ds, count });
    }
  }

  const operatingDays = dailyCounts.length;
  const totalMeals = dailyCounts.reduce((s, d) => s + d.count, 0);
  const avgAttendance = operatingDays ? Math.round((totalMeals / operatingDays) * 10) / 10 : 0;

  let maxDay: PeriodStats["maxDay"] = null;
  let minDay: PeriodStats["minDay"] = null;
  for (const d of dailyCounts) {
    if (!maxDay || d.count > maxDay.count) maxDay = { date: d.date, count: d.count };
    if (!minDay || d.count < minDay.count) minDay = { date: d.date, count: d.count };
  }

  let chart: PeriodChartPoint[];
  if (key.kind === "month") {
    chart = dailyCounts.map((d) => ({ label: d.date.slice(8), value: d.count }));
  } else if (key.kind === "year") {
    const byMonth = new Map<string, number[]>();
    for (const d of dailyCounts) {
      const mk = d.date.slice(0, 7);
      if (!byMonth.has(mk)) byMonth.set(mk, []);
      byMonth.get(mk)!.push(d.count);
    }
    chart = Array.from(byMonth.entries()).map(([mk, vals]) => ({
      label: `${Number(mk.slice(5, 7))}월`,
      value: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10,
    }));
  } else {
    const byWeek = new Map<number, number[]>();
    for (let i = 0; i < dailyCounts.length; i++) {
      const wk = Math.floor(i / 7);
      if (!byWeek.has(wk)) byWeek.set(wk, []);
      byWeek.get(wk)!.push(dailyCounts[i].count);
    }
    chart = Array.from(byWeek.entries()).map(([wk, vals]) => ({
      label: `${wk + 1}주`,
      value: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10,
    }));
  }

  const perResident: PeriodResidentStat[] = active
    .map((r) => {
      // 결석은 기록이 없습니다 — 등록 뒤의 운영일을 분모로 삼아야 결석이 잡힙니다.
      // 예전에는 `val !== undefined`로 걸러 오신 날만 세는 바람에 전원이 100%,
      // 결석 0일로 나왔습니다.
      let present = 0;
      let total = 0;
      for (const d of dailyCounts) {
        if (r.registeredAt > d.date) continue;
        total++;
        if (r.attendance[d.date]) present++;
      }
      const rate = total ? Math.round((present / total) * 1000) / 10 : 0;
      return { resident: r, present, total, absentDays: total - present, rate };
    })
    .filter((p) => p.total > 0);

  const perfectAttendanceTop10 = [...perResident].sort((a, b) => b.rate - a.rate).slice(0, 10);
  const mostAbsentTop10 = [...perResident].sort((a, b) => b.absentDays - a.absentDays).slice(0, 10);

  return {
    label,
    operatingDays,
    totalMeals,
    avgAttendance,
    maxDay,
    minDay,
    chart,
    perfectAttendanceTop10,
    mostAbsentTop10,
  };
}

export function getAvailableMonths(count = 12): { year: number; month: number; label: string }[] {
  const result: { year: number; month: number; label: string }[] = [];
  let y = DATA_END_DATE.getFullYear();
  let m = DATA_END_DATE.getMonth() + 1;
  for (let i = 0; i < count; i++) {
    result.push({ year: y, month: m, label: `${y}년 ${m}월` });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return result;
}

export function getAvailableQuarters(
  count = 8,
): { year: number; quarter: 1 | 2 | 3 | 4; label: string }[] {
  const result: { year: number; quarter: 1 | 2 | 3 | 4; label: string }[] = [];
  let y = DATA_END_DATE.getFullYear();
  let q = Math.floor(DATA_END_DATE.getMonth() / 3) + 1;
  for (let i = 0; i < count; i++) {
    result.push({ year: y, quarter: q as 1 | 2 | 3 | 4, label: `${y}년 ${q}분기` });
    q -= 1;
    if (q === 0) {
      q = 4;
      y -= 1;
    }
  }
  return result;
}

export function getAvailableHalves(count = 4): { year: number; half: 1 | 2; label: string }[] {
  const result: { year: number; half: 1 | 2; label: string }[] = [];
  let y = DATA_END_DATE.getFullYear();
  let h = (DATA_END_DATE.getMonth() < 6 ? 1 : 2) as 1 | 2;
  for (let i = 0; i < count; i++) {
    result.push({ year: y, half: h, label: `${y}년 ${h === 1 ? "상반기" : "하반기"}` });
    h = (h === 1 ? 2 : 1) as 1 | 2;
    if (h === 2) y -= 1;
  }
  return result;
}

export function getAvailableYears(count = 3): { year: number; label: string }[] {
  const result: { year: number; label: string }[] = [];
  const y = DATA_END_DATE.getFullYear();
  for (let i = 0; i < count; i++) result.push({ year: y - i, label: `${y - i}년` });
  return result;
}

// 개발 모드에서만 콘솔에 진단 창구를 답니다(배포본에는 없습니다).
if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__diag = diagnoseRisk;
}
