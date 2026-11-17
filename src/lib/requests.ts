// 가입 신청과 건의·문의를 다룹니다.
//
// attendance-engine.ts에 넣지 않은 이유: 그쪽은 앱이 열릴 때 모든 화면이 쓰는 데이터를 한 번에 받아오는
// 저장소입니다. 이 두 표는 조회 권한이 로그인한 직원에게만 있어서, 비로그인 방문자가 대시보드를
// 열 때마다 권한 오류가 찍히게 됩니다. 그래서 관리자 화면에서 필요할 때만 직접 불러옵니다.
import { supabase } from "./supabase-client";

// 가입 신청을 승인할 수 있는 계정.
//
// 이 목록은 관리자 화면에서 "가입 신청" 탭을 보여줄지 결정하는 데만 씁니다. 실제로 막는 것은
// 데이터베이스 쪽 정책(supabase/migration_009_approver_only.sql 의 is_access_approver 함수)이라,
// 여기를 고쳐도 권한이 생기지는 않습니다. 두 곳을 항상 같이 맞춰주세요 —
// 여기에만 넣으면 탭은 보이지만 목록이 비어 보이고, 저쪽에만 넣으면 탭이 안 보입니다.
const APPROVER_EMAILS = [
  "approver@example.org", // <자리표시자> 자기 기관 승인 담당자 이메일로 바꾸세요
  // 데모(시연) 계정은 일부러 넣지 않았습니다 — 심사위원에게 공유하는 계정에 승인 권한을 주면
  // 그 계정을 아는 누구나 다른 사람의 가입을 승인할 수 있게 됩니다.
];

export function isAccessApprover(email: string | null | undefined): boolean {
  if (!email) return false;
  return APPROVER_EMAILS.includes(email.trim().toLowerCase());
}

// ── 내 승인 상태 ───────────────────────────────────────────

// 로그인은 됐지만 아직 볼 권한이 없는 상태를 구분하기 위한 값입니다.
//   approved → 승인됨, 데이터를 봅니다
//   pending  → 신청은 접수됐고 담당자 승인 대기
//   rejected → 반려됨
//   none     → 신청서가 없음 (관리자 화면에서 직접 만든 계정 등)
export type MyAccessStatus = "approved" | "pending" | "rejected" | "none";

/**
 * 지금 로그인한 계정이 승인됐는지 데이터베이스에 물어봅니다.
 *
 * access_requests 표를 직접 읽지 않고 함수를 부르는 이유: 그 표는 담당자만 읽을 수 있게
 * 잠겨 있어서, 일반 직원이 직접 조회하면 자기 줄조차 안 보입니다. my_access_status() 는
 * security definer 로 만들어져 본인 상태 한 줄만 돌려줍니다.
 *
 * 함수가 없어서 실패하면(= migration_010을 아직 실행하지 않음) approved 로 봅니다. 이 화면
 * 쪽 판정은 "왜 안 보이는지" 안내를 띄우기 위한 것이고, 실제로 막는 것은 데이터베이스
 * 정책입니다. 여기서 닫아버리면 마이그레이션 실행 전까지 모두가 잠깁니다.
 */
export async function fetchMyAccessStatus(): Promise<MyAccessStatus> {
  const { data, error } = await supabase.rpc("my_access_status");
  if (error) {
    // 확인하지 못했으면 **막습니다**.
    //
    // 예전에는 여기서 'approved'를 돌려줬습니다. 마이그레이션을 아직 실행하지 않은 상태에서
    // 화면이 막혀버리는 것을 피하려던 것인데, 이게 곧 "확인 요청을 실패하게 만들면 통과"가
    // 됩니다. 개발자도구로 이 요청 하나만 막으면 승인 대기 계정도 화면이 열렸습니다.
    // 마지막 방어선인 RLS가 자료를 막아주긴 하지만, 방어선이 하나뿐인 상태였습니다.
    //
    // 못 들어가는 불편은 담당자에게 연락하면 풀립니다. 잘못 들어간 것은 되돌릴 수 없습니다.
    console.error("승인 상태를 확인하지 못했습니다.", error.message);
    return "none";
  }
  const value = typeof data === "string" ? data : "";
  if (value === "approved" || value === "pending" || value === "rejected" || value === "none") {
    return value;
  }
  return "none";
}

export type AccessRequestStatus = "pending" | "approved" | "rejected";
export type SuggestionCategory = "건의" | "질문" | "오류 신고";
export type SuggestionStatus = "open" | "done";

export interface AccessRequest {
  id: string;
  email: string;
  name: string;
  note: string;
  status: AccessRequestStatus;
  createdAt: string;
}

export interface Suggestion {
  id: string;
  author: string;
  category: SuggestionCategory;
  text: string;
  status: SuggestionStatus;
  reply: string;
  createdAt: string;
}

// 같은 밀리초에 두 사람이 보내도 겹치지 않도록 뒤에 짧은 난수를 붙입니다.
function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── 가입 신청 ──────────────────────────────────────────────

export async function submitAccessRequest(input: {
  email: string;
  name: string;
  note: string;
}): Promise<{ error: string | null }> {
  const { error } = await supabase.from("access_requests").insert({
    id: newId("ar"),
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    note: input.note.trim(),
  });
  return { error: error ? error.message : null };
}

export async function fetchAccessRequests(): Promise<{
  rows: AccessRequest[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("access_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return { rows: [], error: error.message };
  const rows = (data ?? []).map((r) => ({
    id: r.id as string,
    email: r.email as string,
    name: (r.name ?? "") as string,
    note: (r.note ?? "") as string,
    status: r.status as AccessRequestStatus,
    createdAt: r.created_at as string,
  }));
  return { rows, error: null };
}

export async function setAccessRequestStatus(
  id: string,
  status: AccessRequestStatus,
): Promise<{ error: string | null }> {
  const { error } = await supabase.from("access_requests").update({ status }).eq("id", id);
  return { error: error ? error.message : null };
}

export async function deleteAccessRequest(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("access_requests").delete().eq("id", id);
  return { error: error ? error.message : null };
}

// ── 건의·문의 ──────────────────────────────────────────────

export async function submitSuggestion(input: {
  author: string;
  category: SuggestionCategory;
  text: string;
}): Promise<{ error: string | null }> {
  const { error } = await supabase.from("suggestions").insert({
    id: newId("sg"),
    author: input.author.trim(),
    category: input.category,
    text: input.text.trim(),
  });
  return { error: error ? error.message : null };
}

export async function fetchSuggestions(): Promise<{ rows: Suggestion[]; error: string | null }> {
  const { data, error } = await supabase
    .from("suggestions")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return { rows: [], error: error.message };
  const rows = (data ?? []).map((r) => ({
    id: r.id as string,
    author: (r.author ?? "") as string,
    category: r.category as SuggestionCategory,
    text: r.text as string,
    status: r.status as SuggestionStatus,
    reply: (r.reply ?? "") as string,
    createdAt: r.created_at as string,
  }));
  return { rows, error: null };
}

export async function updateSuggestion(
  id: string,
  patch: { status?: SuggestionStatus; reply?: string },
): Promise<{ error: string | null }> {
  const { error } = await supabase.from("suggestions").update(patch).eq("id", id);
  return { error: error ? error.message : null };
}

export async function deleteSuggestion(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("suggestions").delete().eq("id", id);
  return { error: error ? error.message : null };
}
