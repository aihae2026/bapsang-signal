// 엔컴(ENCOM) 「기간별 입금현황」 엑셀을 읽어 바로 데이터베이스에 반영합니다.
//
// 지금까지는 scripts/attendance-xls-to-csv.py 로 CSV를 만든 뒤 Supabase Table Editor에서
// 손으로 가져와야 했습니다. 그 과정을 화면 안으로 옮긴 것이 이 파일입니다. 판정 규칙은
// 파이썬 스크립트와 **똑같이** 맞췄습니다(실명 가림·구분 판정·오신 날만 기록).
//
// 개인정보 원칙(스크립트와 동일):
//  · 실명을 저장하지 않습니다. 홍길동 → 홍○동 로 **가려서** 넣습니다. 직원은 회원번호로
//    엔컴에서 확인할 수 있으므로 업무상 잃는 것이 없습니다.
//  · 나이·전화·담당자는 이 자료에 없습니다. 지어내지 않고 "미상/미등록/미지정"으로 둡니다.
import * as XLSX from "xlsx";
import { supabase } from "./supabase-client";

export interface EncomRecord {
  date: string; // YYYY-MM-DD
  name: string; // 원본 이름(가리기 전) — 동명이인 점검에만 쓰고 저장하지 않습니다
  member: string; // 이용자번호 = 회원번호
  amount: string; // "3500" | "1800" | "" (무료)
}

export interface ParsedEncom {
  records: EncomRecord[];
  skippedRows: number; // 머리말·바닥글 등 자료가 아닌 줄
  residents: {
    id: string;
    name: string;
    age_group: string;
    caseworker: string;
    phone: string;
    registered_at: string;
    status: string;
    meal_tier: string;
  }[];
  attendance: { resident_id: string; date: string; present: boolean }[];
  summary: {
    from: string;
    to: string;
    recordCount: number;
    residentCount: number;
    operatingDays: number;
    tiers: { label: string; count: number }[];
  };
  warnings: {
    kind: "duplicateName" | "surgeDay" | "unknownAmount" | "badMemberId";
    text: string;
  }[];
  errors: string[];
}

/** 엔컴 회원번호 모양. 'YYYY-NNNNN' (연도 4자리 + 하이픈 + 숫자). */
const MEMBER_ID = /^\d{4}-\d{3,7}$/;

/** 이름 가운데를 가립니다. 홍길동 → 홍○동 (엔컴이 붙인 동명이인 꼬리표 숫자는 떼어냄) */
export function maskName(raw: string): string {
  const name = raw.replace(/[0-9]+$/, "").trim();
  if (name.length <= 1) return name;
  if (name.length === 2) return name[0] + "○";
  return name[0] + "○".repeat(name.length - 2) + name[name.length - 1];
}

/** 엑셀 칸 값을 YYYY-MM-DD 로. 날짜 개체·문자열·엑셀 일련번호를 모두 받습니다. */
function toDateStr(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const parsed = XLSX.SSF.parse_date_code(v);
    if (!parsed) return null;
    return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function cell(row: unknown[], i: number | null): string {
  if (i === null || i < 0) return "";
  return String(row[i] ?? "").trim();
}

/**
 * 머리글 줄을 찾아 열 위치를 알아냅니다.
 *
 * 파일마다 열 구성이 다릅니다(1~4월분은 14열·3번째 줄, 5월 이후는 16열·4번째 줄). 열 번호를
 * 고정하면 한쪽이 조용히 어긋나 엉뚱한 칸을 읽으므로, '순번'과 '처리일자'가 있는 줄을 찾아
 * 이름으로 맞춥니다. 금액은 머리글이 두 줄이라(위 '입금액', 아래 '현금'·'카드') 아랫줄에서 찾습니다.
 */
function findColumns(rows: unknown[][]) {
  for (let r = 0; r < Math.min(10, rows.length); r++) {
    const row = (rows[r] ?? []).map((c) => String(c ?? "").trim());
    if (row.includes("순번") && row.includes("처리일자")) {
      const sub = (rows[r + 1] ?? []).map((c) => String(c ?? "").trim());
      const find = (label: string) => {
        const i = row.indexOf(label);
        return i === -1 ? null : i;
      };
      return {
        headerRow: r,
        seq: find("순번"),
        date: find("처리일자"),
        name: find("이용자명"),
        member: find("이용자번호"),
        cash: sub.indexOf("현금") === -1 ? null : sub.indexOf("현금"),
        card: sub.indexOf("카드") === -1 ? null : sub.indexOf("카드"),
      };
    }
  }
  return null;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function parseEncomFiles(files: File[]): Promise<ParsedEncom> {
  const records: EncomRecord[] = [];
  const errors: string[] = [];
  const badMemberIds = new Set<string>();
  let skippedRows = 0;

  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: true,
        defval: "",
        blankrows: true,
      });
      const cols = findColumns(rows);
      if (!cols || cols.date === null || cols.member === null) {
        errors.push(`${file.name}: 머리글(순번·처리일자·이용자번호)을 찾지 못했습니다.`);
        continue;
      }
      // ★ 머리글 **한 줄 아래**부터 읽습니다.
      //
      //   엔컴 자료는 머리글이 두 줄이라(위 「입금액」, 아래 「현금」·「카드」) 예전에는 두 줄을
      //   건너뛰었습니다. 그런데 엔컴을 쓰지 않는 기관에 드리는 **빈 입력 양식**은 머리글이 한
      //   줄입니다. 두 줄을 건너뛰면 그 양식의 첫 자료 줄이 아무 말 없이 버려져, 예시 줄을 지우고
      //   적으신 분 한 분이 통째로 사라집니다 — 화면에는 경고도 뜨지 않습니다.
      //
      //   한 줄만 건너뛰어도 안전합니다. 엔컴의 아랫줄 머리글에는 날짜가 없어 바로 아래 검사에
      //   걸려 그냥 넘어갑니다.
      for (let r = cols.headerRow + 1; r < rows.length; r++) {
        const row = rows[r] ?? [];
        // 빈 입력 양식 2행의 예시 줄(순번 칸에 「예시」)은 자료가 아닙니다. 지우고 쓰시라고
        // 화면에 적어 두었지만, 그냥 두고 올리셔도 홍○동(2026-0000)이라는 있지도 않은 분이
        // 명부에 들어가면 안 됩니다.
        if (cell(row, cols.seq) === "예시") continue;
        const date = toDateStr(row[cols.date]);
        const member = cell(row, cols.member);
        // 보고서 출력물이라 머리글·바닥글이 되풀이됩니다. 날짜 모양이 아니면 자료가 아닙니다.
        if (!date || !member) {
          skippedRows++;
          continue;
        }
        // ★ 회원번호 형식을 봅니다. 엔컴 회원번호는 'YYYY-NNNNN' 꼴입니다.
        //
        //   실제로 회원번호 자리에 **날짜가 들어간 자료**가 반영된 적이 있습니다
        //   ("Wed Nov 01 2023 00:00:00 GMT+0900"). 열이 밀렸거나 빈 칸이 있을 때
        //   생깁니다. 그대로 넣으면 그 어르신은 엔컴에서 조회할 수 없는 유령이 되고,
        //   출결도 그 가짜 번호에 붙어 되돌리기 어려워집니다.
        if (!MEMBER_ID.test(member)) {
          badMemberIds.add(member.slice(0, 40));
          continue;
        }

        let amount = "";
        for (const c of [cols.cash, cols.card]) {
          const raw = cell(row, c).replace(/,/g, "");
          if (raw) {
            const n = Number(raw);
            amount = Number.isFinite(n) ? String(Math.round(n)) : raw;
            break;
          }
        }
        records.push({ date, name: cell(row, cols.name), member, amount });
      }
    } catch (e) {
      errors.push(`${file.name}: 읽지 못했습니다 (${String(e)})`);
    }
  }

  // ── 집계 ────────────────────────────────────────────────────
  const nameOf = new Map<string, string>();
  const firstSeen = new Map<string, string>();
  const came = new Map<string, Set<string>>();
  const tierCount = new Map<string, Map<string, number>>();

  for (const rec of records) {
    nameOf.set(rec.member, rec.name);
    const prev = firstSeen.get(rec.member);
    if (!prev || rec.date < prev) firstSeen.set(rec.member, rec.date);
    if (!came.has(rec.member)) came.set(rec.member, new Set());
    came.get(rec.member)!.add(rec.date);
    const key = rec.amount || "무료";
    if (!tierCount.has(rec.member)) tierCount.set(rec.member, new Map());
    const m = tierCount.get(rec.member)!;
    m.set(key, (m.get(key) ?? 0) + 1);
  }

  const TIER_LABEL: Record<string, string> = { 무료: "무료급식", "1800": "감면", "3500": "일반" };
  // 금액표에 없는 값은 조용히 '일반'으로 떨어집니다. 급식비가 바뀌면(1,800 → 2,000원) 감면
  // 어르신이 통째로 '일반'이 되어 수급·저소득 보기에서 사라지므로, 묻어두지 않고 알립니다.
  const unknownAmounts = new Map<string, number>();
  for (const rec of records) {
    const key = rec.amount || "무료";
    if (!(key in TIER_LABEL)) unknownAmounts.set(key, (unknownAmounts.get(key) ?? 0) + 1);
  }
  const residents = [...nameOf.keys()].sort().map((member) => {
    const counts = tierCount.get(member)!;
    let top = "무료";
    let best = -1;
    for (const [k, v] of counts) if (v > best) [top, best] = [k, v];
    return {
      id: member,
      name: maskName(nameOf.get(member) ?? ""),
      age_group: "미상",
      caseworker: "미지정",
      phone: "미등록",
      registered_at: firstSeen.get(member)!,
      status: "active",
      meal_tier: TIER_LABEL[top] ?? "일반",
    };
  });

  // 오신 날만 적습니다. 안 오신 날까지 적으면 수십만 행이 되고, 앱은 "운영일인데 기록이
  // 없으면 결석"으로 읽습니다.
  const attendance: ParsedEncom["attendance"] = [];
  for (const member of [...came.keys()].sort()) {
    for (const d of [...came.get(member)!].sort()) {
      attendance.push({ resident_id: member, date: d, present: true });
    }
  }

  const dates = [...new Set(records.map((r) => r.date))].sort();
  const tierTally = new Map<string, number>();
  for (const r of residents) tierTally.set(r.meal_tier, (tierTally.get(r.meal_tier) ?? 0) + 1);

  // ── 확인이 필요한 항목(자동으로 고치지 않고 보고만 합니다) ──
  const warnings: ParsedEncom["warnings"] = [];
  if (badMemberIds.size > 0) {
    warnings.push({
      kind: "badMemberId",
      text: `회원번호 모양이 아닌 값 ${badMemberIds.size}가지를 빼고 읽었습니다 (예: ${[...badMemberIds].slice(0, 2).join(", ")}). 엑셀에서 열이 밀렸거나 빈 칸이 있는지 확인해주세요.`,
    });
  }
  for (const [amount, n] of [...unknownAmounts.entries()].sort((x, y) => y[1] - x[1])) {
    warnings.push({
      kind: "unknownAmount",
      text: `금액 ${Number(amount).toLocaleString()}원이 ${n.toLocaleString()}건 있습니다 — 구분표에 없어 '일반'으로 넣습니다. 급식비가 바뀌었다면 확인이 필요합니다.`,
    });
  }
  const byName = new Map<string, Set<string>>();
  for (const [member, name] of nameOf) {
    const key = name.replace(/[0-9]+$/, "").trim();
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key)!.add(member);
  }
  const dups = [...byName.entries()].filter(([, ids]) => ids.size > 1);
  if (dups.length > 0) {
    warnings.push({
      kind: "duplicateName",
      text: `같은 이름이 회원번호 2개 이상 — ${dups.length}명. 동일인이면 엔컴에서 번호를 통합해야 두 사람으로 세지 않습니다.`,
    });
  }
  const perDay = new Map<string, number>();
  for (const r of records) perDay.set(r.date, (perDay.get(r.date) ?? 0) + 1);
  const ds = [...perDay.keys()].sort();
  let surge = 0;
  for (let i = 0; i < ds.length; i++) {
    const near: number[] = [];
    for (let j = Math.max(0, i - 5); j < Math.min(ds.length, i + 6); j++)
      if (j !== i) near.push(perDay.get(ds[j])!);
    if (near.length >= 4) {
      const med = median(near);
      if (med > 0 && perDay.get(ds[i])! >= med * 2.5) surge++;
    }
  }
  if (surge > 0) {
    warnings.push({
      kind: "surgeDay",
      text: `하루 출석이 평소의 2.5배 이상인 날 ${surge}일 — 무료급식 행사면 정상이고, 일괄발권·시스템작업이면 빼야 평소 수준이 부풀지 않습니다.`,
    });
  }

  return {
    records,
    skippedRows,
    residents,
    attendance,
    summary: {
      from: dates[0] ?? "",
      to: dates[dates.length - 1] ?? "",
      recordCount: records.length,
      residentCount: residents.length,
      operatingDays: dates.length,
      tiers: [...tierTally.entries()].map(([label, count]) => ({ label, count })),
    },
    warnings,
    errors,
  };
}

export interface ImportProgress {
  phase: "residents" | "attendance" | "done";
  done: number;
  total: number;
}

/**
 * 파싱한 결과를 데이터베이스에 넣습니다.
 *
 * 어르신은 **새로 보이는 분만 추가**합니다(ignoreDuplicates). 이미 있는 분을 덮어쓰면 화면에서
 * 손으로 넣은 전화번호·특이사항이 "미등록"으로 되돌아갑니다.
 * 출결은 (회원번호, 날짜)가 같으면 덮어쓰므로 같은 파일을 두 번 넣어도 안전합니다.
 */
export async function importEncom(
  parsed: ParsedEncom,
  onProgress?: (p: ImportProgress) => void,
  fileNames: string[] = [],
): Promise<{
  ok: boolean;
  newResidents: number;
  newAttendance: number;
  skippedAttendance: number;
  error?: string;
}> {
  const CHUNK = 500;
  let newResidents = 0;
  let newAttendance = 0;

  // 반영 내역 남기기.
  //
  // 예전에는 두 반복문이 **모두 끝난 뒤에만** 기록했습니다. 그래서 중간에 실패하면 —
  // 로그인이 만료되거나 인터넷이 끊기면 — 수만 건이 이미 들어간 채로 기록은 하나도 남지
  // 않았습니다. 관리자 화면에는 "아직 가져오기 내역이 없습니다"만 보이고요. 무엇이 어디까지
  // 들어갔는지 되짚을 수 없다면 기록의 의미가 없습니다. 실패해도 남깁니다.
  const writeLog = async (note: string) => {
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("import_logs").insert({
      staff_email: userData?.user?.email ?? "",
      file_names: fileNames.join(", ").slice(0, 500),
      period_from: parsed.summary.from || null,
      period_to: parsed.summary.to || null,
      record_count: parsed.summary.recordCount,
      resident_count: parsed.summary.residentCount,
      attendance_rows: parsed.attendance.length,
      new_residents: newResidents,
      new_attendance: newAttendance,
      skipped_attendance: Math.max(0, parsed.attendance.length - newAttendance),
      note,
    });
    // supabase-js는 오류를 던지지 않고 error로 돌려줍니다 — try/catch로는 못 잡습니다.
    // 표가 아직 없을 수 있으니(migration_020 미실행) 화면을 막지는 않되, 조용히 삼키지도
    // 않습니다. 콘솔에 남겨야 왜 내역이 비었는지 알 수 있습니다.
    if (error) console.error("[import_logs] 기록 실패:", error.message);
  };

  // 1) 어르신 — 새로 보이는 분만 추가합니다. 이미 있는 분을 덮어쓰면 화면에서 손으로 넣은
  //    특이사항 같은 것이 되돌아갑니다. 삽입된 행만 돌려받아 "몇 명이 새로 생겼는지" 셉니다.
  for (let i = 0; i < parsed.residents.length; i += CHUNK) {
    const slice = parsed.residents.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("residents")
      .upsert(slice, { onConflict: "id", ignoreDuplicates: true })
      .select("id");
    if (error) {
      await writeLog(`어르신 반영 중 중단됨: ${error.message}`);
      return {
        ok: false,
        newResidents,
        newAttendance,
        skippedAttendance: Math.max(0, parsed.attendance.length - newAttendance),
        error: error.message,
      };
    }
    newResidents += data?.length ?? 0;
    onProgress?.({
      phase: "residents",
      done: Math.min(i + CHUNK, parsed.residents.length),
      total: parsed.residents.length,
    });
  }

  // 2) 출결 — 이미 있는 (회원번호, 날짜)는 **건너뜁니다**(덮어쓰지 않음).
  //    같은 값을 다시 써넣으면 그 행이 매번 바뀐 것으로 취급돼, 넣을 때마다 자료가 출렁이고
  //    무엇이 진짜 새로 들어온 것인지 알 수 없게 됩니다. 건너뛰면 새로 들어온 것만 남습니다.
  for (let i = 0; i < parsed.attendance.length; i += CHUNK) {
    const slice = parsed.attendance.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("attendance")
      .upsert(slice, { onConflict: "resident_id,date", ignoreDuplicates: true })
      .select("resident_id");
    if (error) {
      await writeLog(`출결 반영 중 중단됨(앞부분은 이미 들어갔습니다): ${error.message}`);
      return {
        ok: false,
        newResidents,
        newAttendance,
        skippedAttendance: Math.max(0, parsed.attendance.length - newAttendance),
        error: error.message,
      };
    }
    newAttendance += data?.length ?? 0;
    onProgress?.({
      phase: "attendance",
      done: Math.min(i + CHUNK, parsed.attendance.length),
      total: parsed.attendance.length,
    });
  }

  const skippedAttendance = parsed.attendance.length - newAttendance;

  // 3) 반영 내역 남기기 — 누가 언제 무엇을 넣었는지 되짚을 수 있어야 합니다.
  //    기록에 실패해도 이미 들어간 자료를 되돌리지는 않습니다(기록은 부가 정보).
  await writeLog("");

  onProgress?.({ phase: "done", done: 1, total: 1 });
  return { ok: true, newResidents, newAttendance, skippedAttendance };
}

export interface ImportLog {
  id: number;
  created_at: string;
  staff_email: string;
  file_names: string;
  period_from: string | null;
  period_to: string | null;
  record_count: number;
  resident_count: number;
  attendance_rows: number;
  new_residents: number | null;
  new_attendance: number | null;
  skipped_attendance: number | null;
}

/** 자료 반영 내역(최근순). 표가 없으면 빈 목록과 안내 메시지를 돌려줍니다. */
export async function listImportLogs(
  limit = 30,
): Promise<{ logs: ImportLog[]; error: string | null }> {
  const { data, error } = await supabase
    .from("import_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { logs: [], error: error.message };
  return { logs: (data ?? []) as ImportLog[], error: null };
}

/** 최근에 새로 등록된 어르신(가져오기로 처음 들어온 분 포함). */
export async function listRecentResidents(limit = 20): Promise<{
  rows: { id: string; name: string; created_at: string; meal_tier: string }[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("residents")
    .select("id, name, created_at, meal_tier")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { rows: [], error: error.message };
  return {
    rows: (data ?? []) as { id: string; name: string; created_at: string; meal_tier: string }[],
    error: null,
  };
}
