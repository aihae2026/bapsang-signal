import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Hourglass, MessageSquarePlus, ShieldOff } from "lucide-react";
import { BapsangMark } from "@/components/BapsangMark";
import { supabase } from "@/lib/supabase-client";
import type { MyAccessStatus } from "@/lib/requests";

/**
 * 로그인은 됐지만 아직 볼 권한이 없는 사람에게 보여주는 화면.
 *
 * 이 화면이 필요한 이유: 신청자가 비밀번호를 직접 정하게 하려면 본인이 계정을 만들어야
 * 합니다(비밀번호를 신청 표에 평문으로 담지 않으려면 다른 방법이 없습니다). 그래서 승인
 * 전에도 로그인 자체는 성공하고, 대신 어떤 표도 읽히지 않습니다. 그 상태에서 텅 빈
 * 대시보드를 보여주면 고장으로 오해하게 되므로, 왜 비어 있는지 말해주는 화면을 둡니다.
 *
 * 실제로 데이터를 막는 것은 데이터베이스 정책(supabase/migration_010)입니다. 이 화면을
 * 우회해도 보이는 것은 없습니다.
 */
export function PendingApprovalScreen({
  status,
  email,
  onRecheck,
}: {
  status: Exclude<MyAccessStatus, "approved">;
  email: string | null | undefined;
  onRecheck: () => void;
}) {
  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) toast.error("로그아웃하지 못했습니다. 잠시 후 다시 시도해주세요.");
  };

  const rejected = status === "rejected";

  return (
    <div className="flex min-h-screen flex-col bg-stone-50">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-14">
        {/* 기관 로고를 화면에서 가장 잘 보이는 자리에 둡니다 — 낯선 사람이 잘못 들어온 것이
            아니라 우리 기관 시스템 앞에 서 있다는 것을 먼저 알려주는 편이 낫습니다. */}
        <div className="flex flex-col items-center text-center">
          <img
            src="/brand/ccnoin-logo.png"
            alt="춘천남부노인복지관"
            className="h-12 w-auto"
            width={800}
            height={135}
          />
          <div className="mt-7 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/[0.07]">
              <BapsangMark className="h-6 w-6 text-primary" strokeWidth={2.6} />
            </span>
            <span className="text-lg font-bold tracking-tight">밥상위의 신호</span>
          </div>
        </div>

        <div className="mt-8 rounded-xl border bg-white p-7 shadow-sm">
          <span
            className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
              rejected ? "bg-stone-100" : "bg-amber-50"
            }`}
          >
            {rejected ? (
              <ShieldOff className="h-6 w-6 text-stone-500" />
            ) : (
              <Hourglass className="h-6 w-6 text-amber-600" />
            )}
          </span>

          {rejected ? (
            <>
              <h1 className="text-xl font-bold tracking-tight">사용 권한이 없는 계정입니다</h1>
              <div className="mt-3.5 space-y-3 text-[15px] leading-relaxed text-muted-foreground">
                <p>
                  이 계정의 가입 신청은 승인되지 않았습니다. 잘못된 처리라고 생각되시면 담당자에게
                  문의해주세요.
                </p>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-xl font-bold tracking-tight">관리자 승인을 기다리고 있습니다</h1>
              <div className="mt-3.5 space-y-3 text-[15px] leading-relaxed text-muted-foreground">
                <p>
                  로그인은 정상적으로 되었습니다. 다만 어르신 실명·연락처·건강 기록이 담긴 화면이라,{" "}
                  <b className="font-medium text-foreground">관리자가 승인한 뒤에만</b> 열립니다.
                </p>
                <p>
                  승인되면 지금 정하신{" "}
                  <b className="font-medium text-foreground">그 비밀번호로 그대로</b> 사용하실 수
                  있습니다. 비밀번호를 다시 받거나 바꾸실 필요는 없습니다.
                </p>
                <p>
                  승인까지 시간이 걸릴 수 있습니다. 조금 기다리신 뒤 아래 &ldquo;승인됐는지 다시
                  확인&rdquo;을 눌러보세요.
                </p>
              </div>
            </>
          )}

          {email && (
            <p className="mt-5 rounded-lg bg-stone-50 px-3.5 py-2.5 text-sm text-muted-foreground">
              로그인한 계정 <span className="font-medium text-foreground">{email}</span>
            </p>
          )}

          <div className="mt-6 flex flex-col gap-2.5">
            {!rejected && (
              <Button className="h-12 w-full text-base" onClick={onRecheck}>
                승인됐는지 다시 확인
              </Button>
            )}
            <Button variant="outline" className="h-12 w-full text-base" onClick={signOut}>
              로그아웃
            </Button>
          </div>
        </div>

        <Link
          to="/suggest"
          className="mt-7 flex items-center justify-center gap-2 text-[15px] text-muted-foreground hover:text-foreground hover:underline"
        >
          <MessageSquarePlus className="h-4 w-4" />
          담당자에게 문의하기
        </Link>
      </main>
    </div>
  );
}
