// 식단 자료. 홈페이지 영양식단 게시판(ccnoin.or.kr/guide2)의 이미지를 판독해 옮긴 것을
// Supabase menus 표에서 읽어옵니다.
//
// ── 이 자료로 무엇을 하는가 ────────────────────────────────
// 설계근거 문서 3.3의 메뉴 선호도 변수입니다. 다만 "맛있다/없다"를 사람이 판정하지 않습니다 —
// 사람마다 다르기 때문입니다. 어느 메뉴가 좋았는지는 그날 몇 분이 오셨는지가 말해줍니다.
//
// 특식은 판정할 필요조차 없습니다. 식단표에 이미 적혀 있습니다. 2026년 7월 식단표에는
// 7/8에 「무료급식 행사」, 7/15에 「초복」이 그림으로 붙어 있고, 실제 출석이 828명·752명
// (평소 396명의 2.1배·1.9배)이었습니다.
//
// ⚠️ 순서: 특식을 "출석이 급증한 날"로 정하고 그 특식으로 출석을 설명하면 순환논리입니다.
//    특식은 식단표(입력)에서 읽고, 출석은 그 뒤에 봅니다.
//
// ── 진짜 쓸모는 반대쪽입니다 ───────────────────────────────
// "비선호 메뉴 날의 결석은 봐준다"가 전부라면 별 가치가 없습니다. 거꾸로가 훨씬 셉니다 —
// 828명이 오신 행사일에 안 오신 어르신은, 평소 잘 안 오시던 분도 오시는 날에 못 나오신
// 것입니다. 가장 조사할 가치가 큰 결석입니다.
import { supabase } from "./supabase-client";

export interface DayMenu {
  date: string;
  menu: string;
  kcal: number | null;
  proteinG: number | null;
  /** 식단표에 적힌 행사명. 비어 있으면 평소 식단입니다. */
  eventLabel: string;
  /** 식단표에 「공휴일 휴관」처럼 적힌 날 */
  closed: boolean;
  sourceUrl: string;
}

let MENUS = new Map<string, DayMenu>();

type MenuRow = {
  date: string;
  menu: string | null;
  kcal: number | null;
  protein_g: number | null;
  event_label: string | null;
  closed: boolean | null;
  source_url: string | null;
};

/**
 * 식단을 한 번에 받아 메모리에 담아둡니다.
 *
 * 실패하면 조용히 비워둡니다. 식단은 부가 정보라 못 받아왔다고 화면이 멈추면 안 되고,
 * 무엇보다 지어낸 값으로 채워지면 안 됩니다 — 예전에 날짜를 해시해 식단을 만들어내는
 * 코드가 있었고, 그런 값은 그날 실제로 무엇을 드셨는지 확인해 본 사람에게 거짓말이 됩니다.
 */
export async function loadMenus(): Promise<void> {
  const { data, error } = await supabase
    .from("menus")
    .select("date,menu,kcal,protein_g,event_label,closed,source_url")
    .order("date", { ascending: true });

  if (error) {
    console.warn(
      "식단 자료를 읽지 못했습니다(migration_013 미실행일 수 있음). 식단 표시는 생략됩니다.",
      error.message,
    );
    return;
  }

  const next = new Map<string, DayMenu>();
  for (const r of (data ?? []) as MenuRow[]) {
    next.set(r.date, {
      date: r.date,
      menu: r.menu ?? "",
      kcal: r.kcal,
      proteinG: r.protein_g,
      eventLabel: (r.event_label ?? "").trim(),
      closed: !!r.closed,
      sourceUrl: r.source_url ?? "",
    });
  }
  MENUS = next;
}

export function getMenu(dateStr: string): DayMenu | null {
  return MENUS.get(dateStr) ?? null;
}

export function hasMenuData(): boolean {
  return MENUS.size > 0;
}

/**
 * 그날이 식단표상 행사일인가. 행사명을 그대로 돌려줍니다.
 *
 * 열량으로 판정하지 않는 이유: 7월 식단표에서 행사일 7/8은 910Kcal(그 달 최고)이었지만,
 * 초복인 7/15는 780Kcal로 평범했습니다. 열량은 참고가 되지만 판정 기준은 못 됩니다.
 * 식단표에 적힌 표기가 가장 확실합니다.
 */
export function getMenuEvent(dateStr: string): string | null {
  const m = MENUS.get(dateStr);
  if (!m || m.closed) return null;
  return m.eventLabel || null;
}

/**
 * 그날 식단표에 적힌 사유. **휴관으로 표시된 날도 그대로** 돌려줍니다.
 *
 * getMenuEvent 는 휴관일에 null 을 줍니다 — 문을 안 연 날을 "행사일"로 쳐서 결석을 강조하면
 * 안 되기 때문입니다. 그런데 "왜 그날 사람이 갑자기 줄었나"를 설명할 때는 바로 그 휴관
 * 사유가 답입니다. 쓰임새가 달라 함수를 나눴습니다.
 */
export function getMenuNote(dateStr: string): string | null {
  const m = MENUS.get(dateStr);
  if (!m) return null;
  return m.eventLabel || null;
}

/** 자료가 있는 구간 안에서 행사일이 며칠인지. 화면에서 "자료 부족" 판정에 씁니다. */
export function countMenuEvents(): { events: number; days: number } {
  let events = 0;
  for (const m of MENUS.values()) if (!m.closed && m.eventLabel) events++;
  return { events, days: MENUS.size };
}

/**
 * 행사일을 직접 등록·해제합니다.
 *
 * 지금까지 행사는 식단표(엔컴에서 옮겨온 menus 표)에만 있었습니다. 그런데 식단표에 안
 * 적히는 행사가 있습니다 — 경로잔치, 어버이날 행사, 후원 물품 배부처럼 당일에 정해지는
 * 것들입니다. 담당자가 그런 날을 직접 넣을 수 없으면, 그날 결석을 "가장 강한 신호"로
 * 볼 기회를 놓칩니다.
 *
 * 식단이 없는 날에도 행사만 등록할 수 있게 둡니다(빈 식단 줄을 하나 만듭니다).
 */
export async function setMenuEvent(
  dateStr: string,
  label: string,
): Promise<{ ok: boolean; error: string | null }> {
  const clean = label.trim();
  const existing = MENUS.get(dateStr);
  // 화면이 바로 바뀌게 먼저 반영합니다.
  MENUS.set(dateStr, {
    date: dateStr,
    menu: existing?.menu ?? "",
    kcal: existing?.kcal ?? null,
    proteinG: existing?.proteinG ?? null,
    eventLabel: clean,
    closed: existing?.closed ?? false,
    sourceUrl: existing?.sourceUrl ?? "",
  });
  const { error } = await supabase
    .from("menus")
    .upsert({ date: dateStr, event_label: clean }, { onConflict: "date" });
  if (error) {
    // 실패하면 되돌립니다 — 화면만 바뀐 채로 두면 등록된 줄 압니다.
    if (existing) MENUS.set(dateStr, existing);
    else MENUS.delete(dateStr);
    console.error("행사일 저장 실패", error);
    return { ok: false, error: error.message };
  }
  return { ok: true, error: null };
}

/** 등록된 행사일 목록 (최근 것부터). */
export function listMenuEvents(): { date: string; label: string }[] {
  return [...MENUS.values()]
    .filter((m) => !m.closed && m.eventLabel)
    .map((m) => ({ date: m.date, label: m.eventLabel }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
