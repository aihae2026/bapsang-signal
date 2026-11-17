import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { FileWarning, LogOut, MessageSquarePlus } from "lucide-react";
import { BapsangMark } from "@/components/BapsangMark";
import { supabase } from "@/lib/supabase-client";
import { useSession } from "@/lib/use-session";

const NAV_LINKS = [
  { to: "/dashboard", label: "대시보드" },
  // 회원관리를 상단으로 올립니다.
  //
  // 관리자 설정 안의 탭으로만 있었는데, 어르신 한 분을 찾는 일은 「설정」이 아니라
  // 매일 하는 일입니다. 맞춤돌봄팀이 "이분 급식 오시나요"를 확인하러 들어오는 길도
  // 이것이고요. 대시보드 바로 옆이 맞습니다.
  //
  // 관리자 설정 안의 탭이었는데 이제 독립 화면입니다(members.tsx).
  { to: "/members", label: "회원관리" },
  { to: "/stats", label: "통계·분석" },
  { to: "/resources", label: "자료 관리" },
  { to: "/admin", label: "관리자 설정" },
] as const;

export function NavBar() {
  const session = useSession();
  // 로그아웃은 관리자 설정 안에만 있었습니다. 자리를 비울 때 로그아웃하려고 관리자 페이지를
  // 거쳐야 했는데, 어르신 실명이 뜨는 화면을 켜둔 채 자리를 뜨게 만드는 구조였습니다.
  // 어느 화면에서든 한 번에 닫을 수 있어야 합니다.
  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) toast.error("로그아웃하지 못했습니다. 잠시 후 다시 시도해주세요.");
  };

  return (
    <header className="border-b bg-white">
      <div className="mx-auto flex min-h-14 max-w-7xl flex-wrap items-center justify-between gap-2 px-6 py-2">
        <div className="flex items-center gap-3">
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            <BapsangMark className="h-6 w-6 text-primary" strokeWidth={2.6} />
            밥상위의 신호
          </Link>
          {/* 운영 기관 표시. 좁은 화면에서는 심볼만 남깁니다. */}
          <span className="hidden items-center gap-2 border-l pl-3 sm:flex">
            <img
              src="/brand/ccnoin-mark.png"
              alt=""
              aria-hidden="true"
              className="h-5 w-auto"
              width={68}
              height={64}
            />
            <span className="text-xs text-muted-foreground">춘천남부노인복지관</span>
          </span>
        </div>
        <nav className="flex flex-wrap items-center gap-1 text-sm">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              activeProps={{
                className: "rounded-md px-3 py-1.5 bg-muted text-foreground font-medium",
              }}
            >
              {link.label}
            </Link>
          ))}
          <Link
            to="/risk-report"
            className="ml-1 flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-red-700"
            activeProps={{
              className:
                "ml-1 flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm ring-2 ring-red-300 ring-offset-1",
            }}
          >
            <FileWarning className="h-3.5 w-3.5" />
            위험군 리포트
          </Link>
          {/* 부차적인 통로라 아이콘 위주로 작게 둡니다 — 좁은 화면에서는 글자를 접습니다. */}
          <Link
            to="/suggest"
            title="건의·문의"
            className="ml-1 flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            activeProps={{
              className:
                "ml-1 flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-xs font-medium text-foreground",
            }}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">건의</span>
          </Link>

          {/* 로그인한 계정과 로그아웃. 어느 화면에서든 보여야 자리를 뜰 때 바로 닫습니다. */}
          {session && (
            <span className="ml-1 flex items-center gap-1 border-l pl-2">
              <span
                className="hidden max-w-[13rem] truncate text-xs text-muted-foreground lg:inline"
                title={session.user.email ?? ""}
              >
                {session.user.email}
              </span>
              <button
                type="button"
                onClick={() => void signOut()}
                title="로그아웃"
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">로그아웃</span>
              </button>
            </span>
          )}
        </nav>
      </div>
    </header>
  );
}
