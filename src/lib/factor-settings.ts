// 참고 외부변수 켜기/끄기 값을 Supabase에 읽고 씁니다.
//
// 계산은 external-factors.ts가 하고, 여기서는 저장·불러오기만 맡습니다. 그래야 계산 쪽을
// 네트워크 없이 그대로 검증할 수 있습니다.
//
// 브라우저(localStorage)가 아니라 데이터베이스에 두는 이유: 이 스위치는 위험도 판단을 어떻게
// 읽을지에 대한 기관의 결정입니다. 브라우저에 저장하면 담당자가 "장날 변수는 근거가 없으니
// 끄자"고 결정해도 다른 직원 화면에는 그대로 남아, 같은 어르신을 두고 두 사람이 다른 근거를
// 보게 됩니다.
import { supabase } from "./supabase-client";
import {
  DEFAULT_FACTOR_TOGGLES,
  getFactorToggles,
  getLongAbsenceDays,
  getRegularUserMinRate,
  setFactorToggles,
  setLongAbsenceDays,
  setRegularUserMinRate,
  type FactorToggles,
} from "./external-factors";

const SETTINGS_KEY = "reference_factors";
// 장기 미이용 기준(운영일 수). 켜기/끄기가 아니라 숫자라 따로 둡니다.
const LONG_ABSENCE_KEY = "long_absence_days";
// 정기 이용자 기준(평소 출석률 %). 이 미만이면 출결로 위기를 판단하지 않습니다.
const REGULAR_RATE_KEY = "regular_user_min_rate";

export type { FactorToggles };
export { DEFAULT_FACTOR_TOGGLES, getFactorToggles, getLongAbsenceDays, getRegularUserMinRate };

/** 표에서 읽은 값이 우리가 아는 모양인지 확인해 걸러냅니다. */
function coerce(raw: unknown): FactorToggles {
  const out = { ...DEFAULT_FACTOR_TOGGLES };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(out) as (keyof FactorToggles)[]) {
    if (typeof obj[key] === "boolean") out[key] = obj[key] as boolean;
  }
  return out;
}

export interface LoadResult {
  toggles: FactorToggles;
  /** 표를 못 읽었으면 false. 화면에서 "아직 마이그레이션을 실행하지 않았다"고 알려줍니다. */
  stored: boolean;
}

/**
 * 저장된 스위치 값을 불러와 계산 쪽에 반영합니다.
 *
 * 실패하면 기본값(전부 켜짐)으로 둡니다. 마이그레이션을 아직 실행하지 않았거나 승인 전
 * 계정이면 표를 읽을 수 없는데, 그때 화면이 멈추거나 변수가 임의로 꺼지면 안 됩니다.
 */
export async function loadFactorSettings(): Promise<LoadResult> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle();

  if (error) {
    console.warn(
      "외부변수 설정을 읽지 못했습니다(migration_011 미실행일 수 있음). 전부 켠 상태로 둡니다.",
      error.message,
    );
    setFactorToggles(DEFAULT_FACTOR_TOGGLES);
    return { toggles: { ...DEFAULT_FACTOR_TOGGLES }, stored: false };
  }

  // 행이 아직 없으면(표는 있는데 기본값이 안 들어간 경우) 기본값으로 시작합니다.
  const toggles = coerce(data?.value);
  setFactorToggles(toggles);

  // 장기 미이용 기준도 같이 불러옵니다. 못 읽으면 0(사용 안 함)으로 둡니다 — 기본값이
  // 사람을 빼는 쪽이면, 설정을 못 읽은 것만으로 누군가 조용히 목록에서 사라집니다.
  const { data: la } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", LONG_ABSENCE_KEY)
    .maybeSingle();
  const raw = (la?.value as { days?: unknown } | null)?.days;
  setLongAbsenceDays(typeof raw === "number" ? raw : 0);

  // 정기 이용자 기준도 함께. 못 읽으면 기본값(40)으로 둡니다.
  const { data: rr } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", REGULAR_RATE_KEY)
    .maybeSingle();
  const rrv = (rr?.value as { rate?: unknown } | null)?.rate;
  setRegularUserMinRate(typeof rrv === "number" ? rrv : 40);

  return { toggles, stored: !!data };
}

/**
 * 스위치 값을 저장하고 계산 쪽에도 즉시 반영합니다.
 *
 * 실패하면 화면 상태를 되돌려야 합니다 — 저장이 안 됐는데 꺼진 것처럼 보이면, 다음에 새로
 * 열었을 때 슬그머니 다시 켜져 있어 담당자가 자기 결정이 반영됐는지 알 수 없게 됩니다.
 * 그래서 성공 여부를 그대로 돌려줍니다.
 */
export async function saveFactorSettings(
  next: FactorToggles,
  updatedBy: string,
): Promise<{ error: string | null }> {
  const before = getFactorToggles();
  setFactorToggles(next);

  const { error } = await supabase.from("app_settings").upsert(
    {
      key: SETTINGS_KEY,
      value: next,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "key" },
  );

  if (error) {
    setFactorToggles(before); // 되돌립니다
    return { error: error.message };
  }
  return { error: null };
}

/**
 * 장기 미이용 기준을 저장합니다.
 *
 * 실패하면 되돌립니다 — 저장이 안 됐는데 바뀐 것처럼 보이면, 다음에 열었을 때 슬그머니
 * 원래대로 돌아가 담당자가 자기 결정이 반영됐는지 알 수 없게 됩니다.
 */
export async function saveLongAbsenceDays(
  days: number,
  updatedBy: string,
): Promise<{ error: string | null }> {
  const before = getLongAbsenceDays();
  setLongAbsenceDays(days);

  const { error } = await supabase.from("app_settings").upsert(
    {
      key: LONG_ABSENCE_KEY,
      value: { days },
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "key" },
  );

  if (error) {
    setLongAbsenceDays(before);
    return { error: error.message };
  }
  return { error: null };
}

/**
 * 정기 이용자 기준(평소 출석률 %)을 저장합니다. 실패하면 되돌립니다.
 */
export async function saveRegularUserMinRate(
  rate: number,
  updatedBy: string,
): Promise<{ error: string | null }> {
  const before = getRegularUserMinRate();
  setRegularUserMinRate(rate);

  const { error } = await supabase.from("app_settings").upsert(
    {
      key: REGULAR_RATE_KEY,
      value: { rate },
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "key" },
  );

  if (error) {
    setRegularUserMinRate(before);
    return { error: error.message };
  }
  return { error: null };
}
