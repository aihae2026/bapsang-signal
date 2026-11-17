import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase-client";
import { fetchMyAccessStatus, type MyAccessStatus } from "@/lib/requests";

// 가입·로그인을 허용하는 기관 이메일 도메인.
export const ALLOWED_EMAIL_DOMAIN = "@ccnoin.or.kr";

/**
 * 로그인 상태를 알려주는 훅. 앱 전체가 이 하나를 씁니다.
 *
 * 반환값이 세 가지인 것이 중요합니다:
 *   undefined → 아직 확인 중 (localStorage에 저장된 세션을 읽는 동안)
 *   null      → 로그인하지 않음
 *   Session   → 로그인함
 *
 * "확인 중"과 "로그인 안 함"을 구분하지 않으면, 이미 로그인한 사람이 새로고침할 때마다
 * 로그인 화면이 한 번 번쩍 지나갑니다.
 */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  // 기관 이메일이 아닌 계정은 로그인되어도 즉시 내보냅니다. 화면 쪽 도메인 검사를 우회해
  // 계정이 만들어진 경우까지 한 번 더 막는 장치입니다(실제 방어선은 DB의 RLS 정책입니다).
  useEffect(() => {
    if (session && !session.user.email?.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN)) {
      toast.error(`${ALLOWED_EMAIL_DOMAIN} 기관 이메일 계정만 사용할 수 있습니다.`);
      void supabase.auth.signOut();
    }
  }, [session]);

  return session;
}

/**
 * 로그인한 계정이 담당자 승인을 받았는지 알려주는 훅.
 *
 * 로그인과 승인을 나눈 이유: 신청자가 비밀번호를 직접 정하게 하려면 본인이 계정을 만들어야
 * 하고(비밀번호를 신청 표에 평문으로 담지 않으려면 다른 방법이 없습니다), 그러면 승인 전에도
 * 계정은 존재합니다. 그래서 "계정이 있다"와 "볼 권한이 있다"를 따로 봅니다.
 *
 * 반환값이 undefined 인 동안은 확인 중입니다 — 로그인 직후 이 한 번의 왕복 동안 대시보드를
 * 먼저 그려버리면, 승인 안 된 사람에게 빈 표가 잠깐 보였다 사라집니다.
 *
 * 실제로 데이터를 막는 것은 데이터베이스 정책(supabase/migration_010)입니다. 여기 판정은
 * "왜 안 보이는지"를 설명하는 화면을 띄우기 위한 것입니다.
 */
export function useAccessStatus(session: Session | null | undefined): {
  status: MyAccessStatus | undefined;
  recheck: () => void;
} {
  const [status, setStatus] = useState<MyAccessStatus | undefined>(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!session) {
      setStatus(undefined);
      return;
    }
    let cancelled = false;
    void fetchMyAccessStatus().then((value) => {
      if (!cancelled) setStatus(value);
    });
    return () => {
      cancelled = true;
    };
    // tick 은 "다시 확인" 버튼용입니다 — 담당자가 승인해준 뒤 다시 물어볼 수 있게.
  }, [session, tick]);

  return { status, recheck: () => setTick((n) => n + 1) };
}

/**
 * 지금 로그인한 사람의 이름 — 기록에 적힐 이름입니다.
 *
 * 예전에는 「담당 직원」 목록을 따로 관리하고, 메모나 확인 기록을 남길 때마다 드롭다운에서
 * 자기 이름을 골라야 했습니다. 두 가지가 문제였습니다.
 *   · 목록을 손으로 관리해야 합니다 — 사람이 바뀔 때마다 누군가 고쳐야 합니다
 *   · 첫 번째 사람이 기본값이라, 바쁘면 **남의 이름으로 기록이 남습니다**
 *
 * 가입할 때 이미 이름을 받고 있으므로(auth user_metadata.name) 그걸 그대로 씁니다.
 * 이름이 없는 옛 계정은 이메일 앞부분으로 대신합니다.
 */
export function useStaffName(): string {
  const session = useSession();
  return staffNameOf(session);
}

export function staffNameOf(session: Session | null | undefined): string {
  if (!session) return "";
  const meta = session.user.user_metadata as { name?: string; full_name?: string } | undefined;
  const name = (meta?.name ?? meta?.full_name ?? "").trim();
  if (name) return name;
  const email = session.user.email ?? "";
  return email.split("@")[0] || "담당자";
}
