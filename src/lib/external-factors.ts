// 참고 외부변수 — 설계근거 문서(밥상위의신호_외부변수_설계근거.md)에 정리된 변수들을
// 달력·기상 자료에서 계산합니다.
//
// ── 공휴일과 무엇이 다른가 ─────────────────────────────────
// 공휴일은 기관이 문을 닫는 날이라 "데이터가 없는 날"입니다. 그래서 위험도 계산에서 아예
// 빼야 합니다(빼지 않으면 연휴 직후 전원이 위험군이 됩니다).
//
// 여기 있는 변수들은 성격이 다릅니다. 기관은 열었고 어르신도 올 수 있었지만, 평소보다
// 덜 오실 만한 사정이 있었던 날입니다. 이런 날을 계산에서 빼버리면 안 됩니다 —
//
//   장날은 매달 6일(운영일의 약 30%)입니다. 이걸 다 빼면 남는 자료가 거의 없습니다.
//   그리고 하필 장날부터 안 나오기 시작한 어르신이 그대로 가려집니다.
//
// 그래서 이 변수들은 "제외"가 아니라 "판단에 붙는 설명"으로만 씁니다. 설계근거 문서 4.3의
// 권고와 같습니다 — 알림에 근거를 함께 보여주면 담당자가 스스로 판단할 수 있습니다:
//
//   "맑은 날씨, 장날 아님, 명절과 무관한데도 3일 연속 미이용"  ← 이게 진짜 신호
//   "장날이자 비 20mm 온 날의 결석"                          ← 이건 한 번 더 봐야 함
//
// ── 근거 강도가 서로 다릅니다 ──────────────────────────────
// 문서에 정리된 대로, 변수마다 근거의 성격이 다릅니다. 화면에 그대로 표시해서 담당자가
// "검증된 사실"과 "확인 중인 가설"을 섞어 받지 않도록 합니다.
//
//   결빙        중간 — 국제 연구(낙상 공포·결빙 해빙 주기)
//   장날        이론적 근거만 — 급식소 이용 1순위 동기가 '친구 만남'(38.5%)이고
//               전통시장도 같은 사회적 욕구를 채우는 대체재라는 논리. 직접 검증한 논문 없음
//   명절 전후   직접 근거 없음 — 자체 데이터로 검증해야 함
//   기초연금    신규 가설 — 기초연금 지출 1순위가 식비(74.2%)라는 실태조사에서 출발
//
// 뒤 세 개는 우리 자료로 확인해야 하는 것들입니다. 그래서 getFactorImpact()로 실제 출석률
// 차이를 계산해 화면에 함께 보여줍니다. 차이가 없으면 변수에서 빼면 됩니다.

import { getWeather } from "./weather";
import { getMenuEvent } from "./menus";

export type ReferenceFactorKind =
  | "special"
  | "market"
  | "holidayAdjacent"
  | "pension"
  | "badWeather";

export interface ReferenceFactor {
  kind: ReferenceFactorKind;
  /** 화면에 한 줄로 붙는 표시. 예: "장날 (풍물시장 2·7일장)" */
  label: string;
  /** 왜 이 변수를 보는지 한 줄 설명. 담당자가 근거를 물어볼 때 그대로 보여줍니다. */
  basis: string;
}

export const FACTOR_META: Record<
  ReferenceFactorKind,
  { name: string; evidence: string; color: string }
> = {
  // 다른 넷과 성격이 반대인 변수입니다. 나머지는 "덜 오실 만한 사정"이지만 이것은
  // "더 오실 만한 사정"입니다. 그래서 이 날의 결석이 가장 강한 신호가 됩니다.
  special: {
    name: "특식·행사 (식단표 표기)",
    evidence: "식단표에 기재됨 (확실)",
    color: "bg-rose-500",
  },
  badWeather: {
    name: "날씨",
    evidence: "우리 자료 비 −6.8%p (그중 근거 확실)",
    color: "bg-sky-600",
  },
  market: {
    name: "장날 (풍물시장)",
    evidence: "이론적 근거 · 검증 필요",
    color: "bg-amber-500",
  },
  holidayAdjacent: {
    name: "명절 전후",
    evidence: "자체 검증 필요",
    color: "bg-violet-500",
  },
  pension: {
    name: "기초연금 지급 직후",
    evidence: "신규 가설 · 검증 필요",
    color: "bg-emerald-500",
  },
};

// ── 켜기 / 끄기 ─────────────────────────────────────────────
//
// 근거가 약한 변수는 끌 수 있어야 합니다. 문서가 장날·명절 전후·기초연금을 모두 "자체 검증
// 필요"로 분류했으니, 우리 자료로 확인해보고 관계가 없으면 빼는 것이 정상 절차입니다.
// 근거 없는 변수를 켜둔 채로 두면 "장날이라 안 오셨겠지"로 진짜 신호를 넘겨버립니다.
//
// 값은 Supabase의 app_settings 표에 저장됩니다(factor-settings.ts). 여기서는 계산에 필요한
// 상태만 들고 있어, 이 모듈을 네트워크 없이 그대로 검증할 수 있게 둡니다.
export type FactorToggles = Record<ReferenceFactorKind, boolean>;

// 기본값은 **근거의 세기**로 정합니다.
//
// 켜둔 변수가 붙은 날은 개인 위험도 계산에서 빠집니다. 그러면 그날 안 나오신 것이 기록에
// 남지 않습니다. 장날만 해도 매달 6일 — 운영일의 30%입니다. 검증도 안 된 가설로 그만큼을
// 지워버리면, 하필 그날부터 안 나오기 시작한 어르신이 통째로 가려집니다. 놓치는 것이
// 잘못 알리는 것보다 훨씬 위험합니다.
//
// 그래서 근거가 확실한 것만 켜고 시작합니다. 나머지는 화면의 출석률 차이를 보고 담당자가
// 직접 켭니다 — 우리 자료로 효과가 확인된 뒤에 켜는 것이 순서입니다.
//
//   special   식단표에 적혀 있음 (확실)      → 켬. 다만 이 변수는 애초에 제외에 쓰이지 않고
//                                              "행사일인데 결석"을 강조하는 데만 씁니다
//   freezing  국제 연구 (중간)               → 켬
//   market    이론적 근거 · 검증 필요        → 끔
//   holiday   직접 근거 없음 · 검증 필요     → 끔
//   pension   신규 가설 · 검증 필요          → 끔
export const DEFAULT_FACTOR_TOGGLES: FactorToggles = {
  special: true,
  market: false,
  holidayAdjacent: false,
  pension: false,
  // 악천후는 비가 실제로 효과가 있어(−6.8%p) 켜둡니다. 폭염·결빙은 효과가 흩어짐보다
  // 작거나 검증할 수 없어 이 안에 흡수하되, 붙는 날은 비 기준으로만 정합니다(getBadWeather).
  badWeather: true,
};

let TOGGLES: FactorToggles = { ...DEFAULT_FACTOR_TOGGLES };

export function setFactorToggles(next: Partial<FactorToggles>): void {
  TOGGLES = { ...TOGGLES, ...next };
}

export function getFactorToggles(): FactorToggles {
  return { ...TOGGLES };
}

export function isFactorEnabled(kind: ReferenceFactorKind): boolean {
  return TOGGLES[kind];
}

// ── 날짜 도우미 ─────────────────────────────────────────────
// attendance-engine.ts에도 같은 이름의 함수들이 있지만 여기서 다시 정의합니다. 그쪽에서 가져오면
// attendance-engine → external-factors → attendance-engine 로 순환 참조가 생깁니다.

function parse(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shift(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

function isWeekendDate(d: Date): boolean {
  const w = d.getDay();
  return w === 0 || w === 6;
}

// ── 1. 장날 — 춘천 풍물시장 2·7일장 ────────────────────────
//
// 매월 2·7·12·17·22·27일. 확인: 춘천풍물시장은 상설시장이 아니라 5일장(2·7일)입니다.
// 위치가 온의사거리~호반교 구간이라 복지관(온의동)과 사실상 붙어 있습니다 — 걸어서 갈 수
// 있는 거리라는 점이 '대체재' 가설을 뒷받침합니다(급식소도 대부분 도보 15분 내 접근).
//
// 달력에서 바로 나오는 값이라 별도 자료가 필요 없습니다.
export function isMarketDay(dateStr: string): boolean {
  const day = parse(dateStr).getDate();
  const ones = day % 10;
  return ones === 2 || ones === 7;
}

// ── 2. 명절 전후 ────────────────────────────────────────────
//
// 자녀가 찾아오거나 어르신이 자녀 집으로 가면서 정상적으로 안 오시는 기간입니다. 연휴
// 당일은 이미 공휴일로 제외되므로, 여기서는 연휴 앞뒤만 봅니다.
//
// 앞뒤 3일로 잡은 이유: 문서가 제시한 3~5일 구간 중 가장 좁게 잡았습니다. 넓게 잡으면
// 추석 하나가 열흘 넘게 "명절 전후"로 칠해져 그 기간 신호가 전부 흐려집니다.
const FESTIVAL_WINDOW_DAYS = 3;

// dateStr → "설날 연휴 2일 전" 같은 설명. 명절과 무관한 날은 값이 없습니다.
let FESTIVAL_ADJACENT = new Map<string, string>();

/**
 * 공휴일 목록에서 설날·추석 구간을 찾아 앞뒤 며칠을 표시해둡니다.
 * 공휴일 목록이 바뀔 때마다(어드민에서 추가·삭제) 다시 불러야 합니다.
 */
export function recomputeFestivalAdjacency(holidayLabels: Map<string, string>): void {
  // 거리를 함께 담습니다. 연휴가 여러 날이면 같은 날짜가 여러 번 계산되는데(2/19는 2/17에서
  // 2일 후이면서 2/18에서 1일 후), 그중 가장 가까운 쪽을 남겨야 합니다. 문자열 길이로 비교하면
  // "1일 후"와 "2일 후"가 같은 길이라 먼 쪽이 남습니다.
  const best = new Map<string, { days: number; text: string }>();
  const holidayDates = new Set(holidayLabels.keys());

  for (const [date, label] of holidayLabels.entries()) {
    const festival = label.includes("설날") ? "설날" : label.includes("추석") ? "추석" : null;
    if (!festival) continue;

    const base = parse(date);
    for (let offset = -FESTIVAL_WINDOW_DAYS; offset <= FESTIVAL_WINDOW_DAYS; offset++) {
      if (offset === 0) continue;
      const d = shift(base, offset);
      const key = toStr(d);
      // 연휴 자체와 주말은 애초에 운영일이 아니라 표시할 필요가 없습니다.
      if (holidayDates.has(key) || isWeekendDate(d)) continue;
      const days = Math.abs(offset);
      const text = offset < 0 ? `${festival} 연휴 ${days}일 전` : `${festival} 연휴 ${days}일 후`;
      const prev = best.get(key);
      if (prev && prev.days <= days) continue;
      best.set(key, { days, text });
    }
  }
  FESTIVAL_ADJACENT = new Map([...best].map(([date, v]) => [date, v.text]));
}

export function getFestivalAdjacency(dateStr: string): string | null {
  return FESTIVAL_ADJACENT.get(dateStr) ?? null;
}

// ── 3. 기초연금 지급일 ──────────────────────────────────────
//
// 기초연금은 매월 25일에 나옵니다. 25일이 토·일·공휴일이면 그 직전 평일로 앞당겨 지급합니다.
//
// 가설: 기초연금 수급자의 지출 1순위가 식비(74.2%)이고 소비지출의 51.9%가 식비라면, 돈이
// 들어온 직후에는 밖에서 사 먹거나 장을 봐서 급식소 이용이 줄어들 수 있습니다. 반대로 월말
// 지급 직전에는 늘어날 수 있습니다.
//
// 확인된 사실이 아니라 검증 대상입니다. 그래서 지급일부터 며칠간을 창(window)으로 표시해두고,
// 실제 출석률 차이를 계산해 보여줍니다. 차이가 없으면 이 변수는 빼면 됩니다.
const PENSION_WINDOW_DAYS = 3; // 지급일 당일 + 이후 운영일 2일

let PENSION_WINDOW = new Map<string, string>();

/**
 * 자료 구간 안의 모든 기초연금 지급일과 그 직후 며칠을 표시해둡니다.
 * 지급일 앞당김 판정에 공휴일 목록이 필요하므로 함께 받습니다.
 */
export function recomputePensionWindow(
  startDate: string,
  endDate: string,
  holidayLabels: Map<string, string>,
): void {
  const next = new Map<string, string>();
  const holidayDates = new Set(holidayLabels.keys());
  const start = parse(startDate);
  const end = parse(endDate);

  // 구간 앞뒤로 한 달씩 넉넉히 돌아 경계에 걸친 지급일도 잡습니다.
  const from = new Date(start.getFullYear(), start.getMonth() - 1, 1);
  const to = new Date(end.getFullYear(), end.getMonth() + 1, 1);

  for (
    let cursor = from;
    cursor <= to;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  ) {
    let payday = new Date(cursor.getFullYear(), cursor.getMonth(), 25);
    // 토·일·공휴일이면 직전 평일로. 최대 10일까지만 되짚습니다(무한 반복 방지).
    for (let guard = 0; guard < 10; guard++) {
      if (!isWeekendDate(payday) && !holidayDates.has(toStr(payday))) break;
      payday = shift(payday, -1);
    }

    // 지급일 당일부터 운영일 기준으로 PENSION_WINDOW_DAYS 일을 표시합니다.
    let counted = 0;
    let d = payday;
    for (let guard = 0; guard < 14 && counted < PENSION_WINDOW_DAYS; guard++) {
      const key = toStr(d);
      if (!isWeekendDate(d) && !holidayDates.has(key)) {
        counted++;
        next.set(key, counted === 1 ? "기초연금 지급일" : `기초연금 지급 후 ${counted - 1}일`);
      }
      d = shift(d, 1);
    }
  }
  PENSION_WINDOW = next;
}

export function getPensionWindow(dateStr: string): string | null {
  return PENSION_WINDOW.get(dateStr) ?? null;
}

// ── 4. 결빙 우려 ────────────────────────────────────────────
//
// 국제 연구에서 악천후 시 노인의 외출을 막는 가장 큰 이유로 낙상 공포가 지적되고, 결빙-해빙
// 주기가 야외 보행시간과 관련된다고 보고됩니다. 춘천 겨울에 실제로 해당하는 조건입니다.
//
// 기온만으로는 판단할 수 없습니다 — 영하라도 노면이 말라 있으면 미끄럽지 않습니다. 그래서
// 물기(눈·비)와 영하를 함께 봅니다. 눈은 하루 뒤까지 남으므로 전날 자료도 확인합니다.
//
// 임계값은 실제 춘천 자료(2026-01-01~07-28, 209일)로 확인했습니다:
//   최저 -1℃ 이하           67일
//   적설 0.5cm 이상           9일
//   둘을 함께 본 결과        17일   ← 지금 이 규칙
// 영하만 보면 67일이 되어 겨울의 3분의 1이 통째로 "사정 있는 날"이 됩니다. 그러면 이 변수가
// 아무것도 걸러내지 못합니다.
//
// 처음에는 "해빙·결빙 반복"을 별도 조건으로 두었는데 209일 중 0일이 걸렸습니다. 확인해보니
// 그 상황(전날 눈 + 낮에 녹음)이 이미 아래 조건 안에 10일 들어 있었습니다. 그래서 별도 분기를
// 없애고 표시에만 덧붙입니다 — 걸리지 않는 규칙을 남겨두면 "해빙까지 본다"는 착각을 줍니다.
//
// 악천후 — 비·폭염·결빙을 하나로 봅니다.
//
// 예전에는 셋을 따로 스위치로 두었더니 목록이 난잡했습니다. 우리 자료로 재보니 확실히
// 효과가 있는 것은 비뿐이었고(−6.8%p), 폭염은 흩어짐보다 작았으며(−4.1%p, ±6.1), 결빙은
// 재개관 후 해당하는 날이 하루도 없어 검증할 수 없었습니다.
//
// 그래서 스위치는 하나로 합치되, **날을 정하는 기준은 비 하나로만** 둡니다(5mm 이상). 근거
// 없는 폭염·결빙으로 날을 지우지 않기 위해서입니다. 다만 그날 폭염·결빙도 겹쳤다면 설명에는
// 함께 적습니다 — 담당자가 "왜 이날이 빠졌나"를 볼 때 참고가 됩니다.
//
// 임계값 5mm의 근거: 1mm로 낮추면 운영일의 40%가 걸리는데 효과는 오히려 작아집니다(−3.2%p).
// 이슬비까지 "사정"으로 치면 아무것도 걸러내지 못합니다.
export function getBadWeather(dateStr: string): string | null {
  const w = getWeather(dateStr);
  if (!w) return null;
  if (w.precipitationMm < 5) return null; // 날을 정하는 것은 비뿐입니다

  const round = (n: number) => Math.round(n * 10) / 10;
  const parts = [
    w.precipitationMm >= 20
      ? `비 ${round(w.precipitationMm)}mm (많음)`
      : `비 ${round(w.precipitationMm)}mm`,
  ];
  // 겹친 사정은 설명에만 덧붙입니다.
  if (w.apparentMax >= 35) parts.push(`체감 ${Math.round(w.apparentMax)}℃`);
  if (w.snowfallCm >= 0.5) parts.push(`눈 ${round(w.snowfallCm)}cm`);
  return parts.join(" · ");
}

// ── 장기 미이용 기준 ────────────────────────────────────────
//
// "몇 번을 안 오면 더 이상 위기로 보지 않을 것인가"를 정하는 값입니다.
//
// 이 기관은 사람이 계속 바뀝니다 — 매달 300~700분이 발길을 끊고 그만큼 새로 오십니다.
// 3달 전에 마지막으로 오신 분을 계속 "연속결석 63일 위기"로 목록 맨 위에 두면, 그 목록은
// 옛날에 그만두신 분들로 채워져 정작 이번 주에 끊긴 분이 아래로 밀립니다.
//
// 그렇다고 자동으로 정할 수 있는 값도 아닙니다. 병원에 두 달 입원했다 돌아오시는 분도 있고,
// 정말 그만두신 분도 있는데 출결만으로는 구분이 안 됩니다. 그래서 기관이 정하도록 두고,
// 화면에서 숫자를 바꿔가며 인원이 어떻게 달라지는지 보고 결정하게 합니다.
//
// 0이면 쓰지 않습니다(전부 그대로 봅니다). 단위는 **운영일**입니다 — 달력 날짜로 세면
// 주말·휴관이 섞여 같은 30일이 어떤 달은 20번, 어떤 달은 15번 오실 기회가 됩니다.
// ── 정기 이용자 기준 ────────────────────────────────────────
//
// "평소 출석률이 이 % 이상인 분만 출결로 위기를 판단한다"는 선입니다.
//
// 이 값이 낮으면 원래 띄엄띄엄 오시는 분(주 1회쯤)까지 판단 대상에 들어옵니다. 그런 분은
// 아무 30일 창을 봐도 결석이 이어지기 쉬워서, 실제로는 평소와 다를 게 없는데 "위기"로
// 잡힙니다. 실제 자료로 보면 20%일 때 7월 위기 147명 중 100명 넘게가 이런 분이었습니다.
//
// 기준을 올리면 "평소 자주 오시던 분이 최근 급감" 같은 진짜 신호만 남습니다. 다만 너무
// 올리면 주 2회쯤 오시던 분의 이상 신호를 놓칩니다. 그래서 기관이 화면에서 눌러가며
// 정하도록 둡니다.
//
//   20%  운영일의 1/5 = 주 1회쯤    (너무 넓음 — 가짜 위기 많음)
//   40%  운영일의 2/5 = 주 2회쯤    (권장 출발점)
//   50%  운영일의 절반 이상          (가장 안정적, 위기 ~45명)
export const REGULAR_RATE_PRESETS = [20, 30, 40, 50] as const;
let REGULAR_USER_MIN_RATE = 40;

export function setRegularUserMinRate(n: number): void {
  REGULAR_USER_MIN_RATE = Number.isFinite(n) && n >= 0 && n <= 100 ? Math.floor(n) : 40;
}

export function getRegularUserMinRate(): number {
  return REGULAR_USER_MIN_RATE;
}

// 조기개입 목록에서 "최근 며칠 이내 끊긴 분까지" 볼지 고르는 버튼.
export const EARLY_CUTOFF_PRESETS = [7, 14, 21, 30] as const;

export const LONG_ABSENCE_PRESETS = [0, 21, 42, 63, 84] as const;
let LONG_ABSENCE_DAYS = 0;

export function setLongAbsenceDays(n: number): void {
  LONG_ABSENCE_DAYS = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function getLongAbsenceDays(): number {
  return LONG_ABSENCE_DAYS;
}

/** 이 연속결석 일수가 "이미 이용을 그만두신 것으로 볼 만큼" 긴지. */
export function isLongAbsence(consecutiveOperatingDays: number): boolean {
  return LONG_ABSENCE_DAYS > 0 && consecutiveOperatingDays >= LONG_ABSENCE_DAYS;
}

// ── 종합 ────────────────────────────────────────────────────

/**
 * 그날 붙는 참고 요인 전부. 위험도 계산에는 쓰이지 않고 설명으로만 쓰입니다.
 * 근거가 강한 것부터 나열합니다.
 */
/**
 * 그날 해당하는 요인 전부 — **켜기/끄기를 무시하고** 원래 판정만 합니다.
 *
 * 화면에서 "이 변수를 켜면 이 달 며칠에 표시되는지"를 미리 보여줘야 하는데, 꺼진 변수는
 * getReferenceFactors 가 걸러버려 셀 수가 없습니다. 그래서 판정과 거르기를 나눴습니다.
 */
export function detectReferenceFactors(dateStr: string): ReferenceFactor[] {
  const out: ReferenceFactor[] = [];

  // 식단표에 적힌 행사. 다른 변수와 방향이 반대라 맨 앞에 둡니다 — 이날 결석은 봐줄
  // 이유가 아니라 더 들여다볼 이유입니다.
  const event = getMenuEvent(dateStr);
  if (event) {
    out.push({
      kind: "special",
      label: `${event} · 평소보다 많이 오시는 날`,
      basis:
        "식단표에 표기된 행사입니다. 2026-07-08 「무료급식 행사」 828명, 07-15 「초복」 752명 — 평소 396명의 2배였습니다. 이날 결석은 봐줄 이유가 아니라 더 들여다볼 이유입니다",
    });
  }

  const badWeather = getBadWeather(dateStr);
  if (badWeather) {
    out.push({
      kind: "badWeather",
      label: badWeather,
      basis:
        "우리 자료(행사일 제외·월·요일 통제)에서 비 5mm 이상인 날은 평소보다 6.8%p 적게 오셨습니다. 날을 정하는 기준은 비이고, 폭염·결빙은 겹칠 때 설명에만 덧붙입니다",
    });
  }

  if (isMarketDay(dateStr)) {
    out.push({
      kind: "market",
      label: "장날 (풍물시장 2·7일장)",
      basis:
        "급식소 이용 1순위 동기가 '친구를 만나기 위해'(38.5%)이고, 정기시장도 같은 만남·교류 기능을 함 — 대체재 가설. 직접 검증한 선행연구 없음",
    });
  }

  const festival = getFestivalAdjacency(dateStr);
  if (festival) {
    out.push({
      kind: "holidayAdjacent",
      label: festival,
      basis: "자녀 방문·왕래로 인한 정상 미이용. 직접 근거 논문 없음 — 자체 자료로 검증 중",
    });
  }

  const pension = getPensionWindow(dateStr);
  if (pension) {
    out.push({
      kind: "pension",
      label: pension,
      basis:
        "기초연금 지출 1순위가 식비(74.2%), 소비지출의 51.9%가 식비 (국민연금연구원 실태조사) — 지급 주기가 급식 이용에 영향을 줄 수 있다는 가설",
    });
  }

  return out;
}

/**
 * 화면에 실제로 보여줄 요인 — 꺼둔 변수는 빠집니다.
 */
export function getReferenceFactors(dateStr: string): ReferenceFactor[] {
  return detectReferenceFactors(dateStr).filter((f) => TOGGLES[f.kind]);
}

/**
 * 참고 요인이 하나도 없는 날인가.
 *
 * "설명되는 사정이 아무것도 없는데 안 오셨다"를 판정하는 데 씁니다 — 이 조건이 붙은
 * 연속 결석이 가장 강한 신호입니다.
 */
export function hasNoReferenceFactor(dateStr: string): boolean {
  return getReferenceFactors(dateStr).length === 0;
}
