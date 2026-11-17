// 춘천 실제 기상 자료.
//
// 이전에는 날짜를 해시해 "폭염"·"한파" 같은 말을 계절에 맞게 지어냈습니다. 화면에 한 곳
// (외부변수 패널의 "기관 전체 결석 급증" 사유)에서만 쓰였지만, 실제 어르신 자료를 넣은 뒤에도
// 지어낸 날씨를 붙여두면 그날 날씨를 확인해 본 사람에게는 앞뒤가 맞지 않는 자료가 됩니다.
//
// Open-Meteo의 과거 기상 자료(ERA5 재분석)를 씁니다 — API 키가 필요 없고 무료입니다.
// 재분석 자료라 기상청 관측값과 소수점 단위로는 다를 수 있어, "비 12mm"처럼 사유를 설명하는
// 용도까지만 쓰고 공식 기록으로 인용하지는 않습니다.
//
// ── 우리 자료로 실제 재본 날씨 효과 ────────────────────────
//
// 2026-03-16(재개관) ~ 08-25, 운영일 111일. 행사일 5일을 빼고, 월별 평균과 요일 효과를 함께
// 통제한 뒤 잰 값입니다. 통제 없이 재면 정반대로 나옵니다 — 비 많이 온 날 상위 3일이
// 무료급식 행사·초복과 겹쳐서 "비 오면 사람이 더 온다"는 엉뚱한 결론이 나왔습니다.
//
//   비 5mm 이상   -6.3%p   (44일, 흩어짐 ±8%p)
//   비 20mm 이상  -3.1%p   ( 9일, 흩어짐 ±4%p)
//   체감 33도 이상 -1.1%p   (34일, 흩어짐 ±5%p)
//   체감 37도 이상 -2.9%p   ( 9일, 흩어짐 ±6%p)
//   [참고] 요일    월 +5% / 금 -5%  ← 날씨보다 큽니다
//
// 어느 것도 흩어짐보다 크지 않습니다. 그래서 이 변수들은 꺼둔 채로 시작하고, 담당자가
// 화면의 숫자를 보고 켜도록 합니다.
//
// 눈·한파는 재개관 이후 해당하는 날이 하루도 없어 **검증할 수 없었습니다**. 지금 켜져 있는
// 결빙 변수는 국제 연구에 근거한 것이고, 우리 자료로는 아직 확인되지 않은 상태입니다.

import { supabase } from "./supabase-client";

// 기관 소재지: 강원특별자치도 춘천시 방송길 86
const CHUNCHEON = { latitude: 37.8813, longitude: 127.73 };

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

export interface DayWeather {
  date: string;
  precipitationMm: number;
  snowfallCm: number;
  tempMax: number;
  tempMin: number;
  /**
   * 체감 최고기온. 습도·바람·햇볕까지 반영한 값이라, 여름 더위가 실제로 얼마나 힘들었는지는
   * 기온보다 이쪽이 잘 맞습니다. 춘천 8월은 기온 31도라도 체감 37도가 나옵니다.
   */
  apparentMax: number;
}

const WEATHER = new Map<string, DayWeather>();
let loadPromise: Promise<void> | null = null;

type ArchiveResponse = {
  daily?: {
    time?: string[];
    precipitation_sum?: (number | null)[];
    snowfall_sum?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    apparent_temperature_max?: (number | null)[];
  };
};

/**
 * 지정한 기간의 일별 날씨를 한 번에 받아 메모리에 담아둡니다.
 * 실패하면 조용히 비어 있는 상태로 둡니다 — 날씨는 부가 정보라, 못 받아왔다고 화면이
 * 멈추거나 지어낸 값으로 채워지면 안 됩니다.
 */
export function loadWeather(startDate: string, endDate: string): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    // ① 먼저 보관해 둔 날씨를 읽습니다.
    //
    //    지난 날씨는 바뀌지 않으므로 한 번만 받으면 됩니다. 예전에는 화면을 열 때마다
    //    620일치를 통째로 다시 받아, 직원이 여러 명이면 외부 API 호출 한도에 걸렸습니다.
    //    한도에 걸리면 날씨가 통째로 비어 화면의 근거 문구가 사라집니다.
    await loadCached();

    // ② 아직 없는 날짜만 받아옵니다. 자료가 늘어도 호출은 늘지 않습니다.
    const missing = missingRange(startDate, endDate);
    if (!missing) return; // 전부 갖고 있으면 부를 일이 없습니다
    const params = new URLSearchParams({
      latitude: String(CHUNCHEON.latitude),
      longitude: String(CHUNCHEON.longitude),
      start_date: missing.from,
      end_date: missing.to,
      daily:
        "precipitation_sum,snowfall_sum,temperature_2m_max,temperature_2m_min,apparent_temperature_max",
      timezone: "Asia/Seoul",
    });
    try {
      const res = await fetch(`${ARCHIVE_URL}?${params.toString()}`);
      if (!res.ok) {
        console.warn(`날씨 자료를 받지 못했습니다 (HTTP ${res.status}). 날씨 표시는 생략됩니다.`);
        return;
      }
      const json = (await res.json()) as ArchiveResponse;
      const daily = json.daily;
      if (!daily?.time) return;
      const next = new Map<string, DayWeather>();
      daily.time.forEach((date, i) => {
        const precip = daily.precipitation_sum?.[i];
        const snow = daily.snowfall_sum?.[i];
        const tmax = daily.temperature_2m_max?.[i];
        const tmin = daily.temperature_2m_min?.[i];
        const amax = daily.apparent_temperature_max?.[i];
        // 재분석 자료는 최근 며칠이 아직 안 채워져 null로 옵니다. 그런 날을 0으로 바꿔 담으면
        // "비가 오지 않았음"으로 읽히므로, 아무 값도 없는 날은 아예 넣지 않습니다.
        if (precip == null && snow == null && tmax == null && tmin == null) return;
        next.set(date, {
          date,
          precipitationMm: precip ?? 0,
          snowfallCm: snow ?? 0,
          tempMax: tmax ?? 0,
          tempMin: tmin ?? 0,
          apparentMax: amax ?? tmax ?? 0,
        });
      });
      for (const [date, w] of next) WEATHER.set(date, w);
      void saveCached([...next.values()]); // 다음부터는 안 받아도 되게 남겨둡니다
    } catch (err) {
      console.warn("날씨 자료를 받지 못했습니다. 날씨 표시는 생략됩니다.", err);
    }
  })();
  return loadPromise;
}

/** 보관해 둔 날씨를 읽어옵니다. 표가 아직 없으면(migration_023 미실행) 조용히 넘어갑니다. */
async function loadCached(): Promise<void> {
  const { data, error } = await supabase
    .from("weather")
    .select("date,precipitation_mm,snowfall_cm,temp_max,temp_min,apparent_max")
    .order("date");
  if (error || !data) return;
  for (const r of data as WeatherRow[]) {
    WEATHER.set(r.date, {
      date: r.date,
      precipitationMm: Number(r.precipitation_mm),
      snowfallCm: Number(r.snowfall_cm),
      tempMax: Number(r.temp_max),
      tempMin: Number(r.temp_min),
      apparentMax: Number(r.apparent_max),
    });
  }
}

type WeatherRow = {
  date: string;
  precipitation_mm: number | string;
  snowfall_cm: number | string;
  temp_max: number | string;
  temp_min: number | string;
  apparent_max: number | string;
};

/** 새로 받아온 날씨를 보관합니다. 실패해도 화면은 그대로 돕니다(부가 정보). */
async function saveCached(days: DayWeather[]): Promise<void> {
  if (!days.length) return;
  const rows = days.map((w) => ({
    date: w.date,
    precipitation_mm: w.precipitationMm,
    snowfall_cm: w.snowfallCm,
    temp_max: w.tempMax,
    temp_min: w.tempMin,
    apparent_max: w.apparentMax,
  }));
  const { error } = await supabase.from("weather").upsert(rows, { onConflict: "date" });
  if (error) console.warn("[weather] 보관 실패:", error.message);
}

/**
 * 아직 없는 구간을 구합니다. 한가운데가 비어 있어도 양 끝만 보고 한 번에 받습니다 —
 * 날짜마다 따로 부르면 호출이 오히려 늘어납니다.
 */
function missingRange(startDate: string, endDate: string): { from: string; to: string } | null {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const cur = new Date(sy, sm - 1, sd);
  let first: string | null = null;
  let last: string | null = null;
  for (;;) {
    const ds = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
    if (ds > endDate) break;
    if (!WEATHER.has(ds)) {
      if (!first) first = ds;
      last = ds;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return first && last ? { from: first, to: last } : null;
}

export function getWeather(dateStr: string): DayWeather | null {
  return WEATHER.get(dateStr) ?? null;
}

export function hasWeatherData(): boolean {
  return WEATHER.size > 0;
}

/**
 * 지금 들고 있는 날씨가 며칠치이고 어디부터 어디까지인지.
 *
 * 관리자 화면에서 "자동 연동이 정말 되고 있는가"를 눈으로 확인하는 데 씁니다. 연동이
 * 끊겨도 화면은 조용히 잘 돌아가기 때문에(날씨는 부가 정보라 실패해도 멈추지 않습니다),
 * 어딘가에 상태가 보이지 않으면 몇 달째 안 받아오고 있어도 아무도 모릅니다.
 */
export function getWeatherStatus(): { days: number; from: string | null; to: string | null } {
  if (WEATHER.size === 0) return { days: 0, from: null, to: null };
  const dates = [...WEATHER.keys()].sort();
  return { days: WEATHER.size, from: dates[0], to: dates[dates.length - 1] };
}

/**
 * 결석이 많았던 날의 사유를 짧게 설명합니다. 어르신이 나오기 어려웠을 만한 조건을
 * 먼저 확인하는 순서입니다: 눈 → 비 → 폭염 → 한파 → 그 외.
 */
export function describeWeather(w: DayWeather): string {
  const round = (n: number) => Math.round(n * 10) / 10;
  if (w.snowfallCm >= 1) return `눈 ${round(w.snowfallCm)}cm`;
  if (w.precipitationMm >= 20) return `비 ${round(w.precipitationMm)}mm (많음)`;
  if (w.precipitationMm >= 1) return `비 ${round(w.precipitationMm)}mm`;
  if (w.tempMax >= 33) return `폭염 최고 ${round(w.tempMax)}℃`;
  if (w.tempMin <= -12) return `한파 최저 ${round(w.tempMin)}℃`;
  return `최저 ${round(w.tempMin)}℃ · 최고 ${round(w.tempMax)}℃`;
}
