import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

// ── 보안 헤더 ────────────────────────────────────────────────
// 어르신 개인정보를 다루는 화면이라, 배포된 응답마다 브라우저에 방어선을 함께 내려보냅니다.
//  · CSP: 스크립트·스타일·연결 대상을 우리가 실제로 쓰는 곳으로만 제한(XSS 피해 최소화).
//         앱이 접속하는 외부는 Supabase, 날씨(open-meteo), 폰트(jsdelivr) 셋뿐입니다.
//         supabase.co 는 프로젝트가 바뀌어도 되도록 서브도메인 와일드카드로 둡니다.
//         (SSR 하이드레이션이 인라인 스크립트를 쓰므로 script 'unsafe-inline'은 불가피 —
//          우리 코드엔 사용자 입력을 innerHTML로 넣는 곳이 없어 위험은 낮습니다.)
//  · X-Frame-Options/frame-ancestors: 다른 사이트가 우리 화면을 iframe으로 감싸 클릭을
//         가로채는 것(클릭재킹)을 막습니다.
//  · Referrer-Policy: 주소에 회원번호가 들어가는 상세 페이지(/resident/…)가 외부로 새지
//         않도록, 다른 사이트로 넘어갈 때 경로를 빼고 출처만 보냅니다.
//  · nosniff / Permissions-Policy / HSTS: MIME 스니핑·불필요 기능(카메라 등)·평문 접속 차단.
//
// 개발·미리보기(HMR·프리뷰)에서는 적용하지 않습니다 — dev의 웹소켓·인라인 eval·iframe
// 프리뷰가 막혀 화면이 안 뜰 수 있어서, 위협 대상인 "배포본"에서만 켭니다.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "img-src 'self' data: blob: https://*.supabase.co",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://archive-api.open-meteo.com",
].join("; ");

function withSecurityHeaders(response: Response): Response {
  // dev/preview는 건드리지 않습니다(프로덕션 빌드에서만 PROD=true).
  if (!import.meta.env?.PROD) return response;
  // body는 그대로 흘려보내고(스트리밍 유지) 헤더만 새로 답니다.
  const secured = new Response(response.body, response);
  const h = secured.headers;
  h.set("Content-Security-Policy", CSP);
  h.set("X-Frame-Options", "DENY");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // microphone 은 self 로 엽니다. 확인 기록을 말로 남기는 받아쓰기(VoiceDictateButton)가
  // 크롬에서 이 권한 정책에 걸립니다 — microphone=() 이면 배포본에서 그 단추가 통째로
  // 죽습니다(개발 서버에서는 헤더를 안 붙여서 멀쩡해 보였습니다). 우리 출처에서만 허용하고
  // 카메라·위치는 그대로 막아 둡니다.
  h.set("Permissions-Policy", "camera=(), microphone=(self), geolocation=(), browsing-topics=()");
  h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return secured;
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return withSecurityHeaders(await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return withSecurityHeaders(
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
  },
};
