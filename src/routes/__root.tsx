import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { ensureDataLoaded, resetDataLoad } from "../lib/attendance-engine";
import { LoginScreen } from "@/components/LoginScreen";
import { BrandFooter } from "@/components/BrandFooter";
import { useSession, useAccessStatus } from "@/lib/use-session";
import { PendingApprovalScreen } from "@/components/PendingApprovalScreen";

function RootLoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        데이터를 불러오는 중입니다...
      </div>
    </div>
  );
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "밥상위의 신호" },
      {
        name: "description",
        content: "급식 출결에서 어르신 위기 신호를 조기에 찾아내는 실무자용 대시보드.",
      },
      { name: "author", content: "복지기관 실무자용" },
      // ── 링크 미리보기(카카오톡·슬랙·문자) ─────────────────────────
      //
      // twitter:card 가 summary_large_image 인데 **og:image 가 없었습니다.** 큰 그림
      // 자리를 잡아 놓고 넣을 그림을 안 준 것이라, 링크를 보내면 옆이 빈 칸으로 떴습니다.
      //
      // 그림은 기관에서 만든 「밥상위의 신호」 로고입니다(정사각). 경로식당 사진은 쓰지
      // 않습니다 — 실제 어르신 얼굴이 식별되는 사진이라, 링크 한 번이면 받는 사람의
      // 대화방에 그대로 남고 거기서 어디로 전달될지 알 수 없습니다.
      //
      // og:image 는 **절대 주소**여야 합니다. 상대 경로를 주면 카카오톡·슬랙이
      // 못 찾습니다(그쪽 서버가 우리 페이지를 대신 열어 보기 때문입니다).
      { property: "og:title", content: "밥상위의 신호" },
      {
        property: "og:description",
        content:
          "어르신이 밥상에 앉지 않는 날, 그것부터 신호입니다. 급식 출결에서 위기 신호를 조기에 찾습니다.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://bapsignal.com" },
      { property: "og:site_name", content: "춘천남부노인복지관" },
      { property: "og:locale", content: "ko_KR" },
      { property: "og:image", content: "https://bapsignal.com/og-image.jpg" },
      // 정사각(1200×1200)입니다. 예전에는 1200×630 가로 그림이었는데, 카카오톡이
      // 정사각으로 잘라 **그림이 반만** 보였습니다. 로고가 가운데에 여백을 두고 있어
      // 카카오톡이 가로로 자르든 정사각으로 자르든 그릇이 온전히 남습니다.
      // PNG 로 두면 배경 노이즈 때문에 980KB 였습니다. 같은 그림이 JPEG 로는 77KB 입니다 —
      // 미리보기는 상대 쪽 서버가 받아 가는 그림이라 가벼울수록 빨리 뜹니다.
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "1200" },
      { property: "og:image:alt", content: "밥상위의 신호 — 밥 한 그릇을 가로지르는 맥박선" },
      { property: "og:image:type", content: "image/jpeg" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "밥상위의 신호" },
      {
        name: "twitter:description",
        content: "어르신이 밥상에 앉지 않는 날, 그것부터 신호입니다.",
      },
      { name: "twitter:image", content: "https://bapsignal.com/og-image.jpg" },
    ],
    links: [
      // Pretendard — 한국어 화면용 서체. OS 기본 서체에 맡기면 윈도우(맑은 고딕)와 맥에서
      // 자모 간격·굵기가 크게 달라 보입니다. 동적 서브셋 버전이라 필요한 글자만 내려받습니다.
      {
        rel: "stylesheet",
        href: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
      // 브라우저 탭·홈 화면 아이콘도 기관 심볼로 맞춥니다. PNG를 먼저 두어 최신 브라우저가
      // 이쪽을 쓰게 하고, .ico는 옛 브라우저용으로 남겨둡니다.
      { rel: "icon", href: "/icon-64.png", type: "image/png", sizes: "64x64" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

// 로그인 없이 열어두는 경로. 건의·문의는 어르신 정보가 전혀 없는 화면이고, 로그인이 막힌
// 사람이 이유를 물어볼 유일한 통로라 잠그지 않습니다.
const PUBLIC_PATHS = ["/suggest", "/reset-password"];

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const session = useSession();
  // 로그인과 승인은 다릅니다 — 신청자가 비밀번호를 직접 정하게 하려면 본인이 계정을 만들어야
  // 하므로, 승인 전에도 로그인 자체는 성공합니다. 무엇을 보여줄지는 이 두 값을 함께 봅니다.
  const { status: accessStatus, recheck } = useAccessStatus(session);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isPublicPath = PUBLIC_PATHS.includes(pathname);

  // residents는 클라이언트/서버가 각자 별도의 JS 런타임(모듈 인스턴스)을 갖기 때문에,
  // 서버에서 미리 불러온 데이터가 브라우저로 자동으로 넘어오지 않습니다. 그래서 항상 서버·
  // 클라이언트 모두 "로딩 중" 상태로 첫 렌더를 맞춘 뒤(하이드레이션 불일치 방지), 클라이언트에서
  // 마운트 후 실제로 Supabase에서 데이터를 불러와 교체합니다.
  const [ready, setReady] = useState(false);

  // 승인까지 받은 뒤에 데이터를 불러옵니다. 승인 전에는 데이터베이스 정책이 모든 표를
  // 막으므로, 미리 불러오면 빈 결과가 캐시에 남아 승인된 뒤에도 계속 빈 화면이 보입니다.
  useEffect(() => {
    if (!session || accessStatus !== "approved") {
      if (session === null) resetDataLoad();
      setReady(false);
      return;
    }
    let cancelled = false;
    ensureDataLoaded()
      .then(() => !cancelled && setReady(true))
      .catch((error) => {
        console.error("초기 데이터 로드 실패", error);
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session, accessStatus]);

  // 로그인 화면에는 푸터를 붙이지 않습니다 — 그 화면은 자체적으로 기관 로고를 크게 보여줍니다.
  let content: ReactNode;
  if (isPublicPath) {
    content = (
      <>
        <Outlet />
        <BrandFooter />
      </>
    );
  } else if (session === undefined) {
    content = <RootLoadingScreen />; // 저장된 로그인 세션을 확인하는 동안
  } else if (session === null) {
    content = <LoginScreen />;
  } else if (accessStatus === undefined) {
    content = <RootLoadingScreen />; // 승인 여부를 확인하는 동안
  } else if (accessStatus !== "approved") {
    content = (
      <PendingApprovalScreen status={accessStatus} email={session.user.email} onRecheck={recheck} />
    );
  } else {
    content = ready ? (
      <>
        <Outlet />
        <BrandFooter />
      </>
    ) : (
      <RootLoadingScreen />
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      {content}
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}
