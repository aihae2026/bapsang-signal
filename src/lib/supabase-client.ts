import { createClient } from "@supabase/supabase-js";

// 접속할 Supabase 프로젝트는 .env 의 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 로 정합니다.
//
// 예전에는 값이 비면 춘천남부 운영 Supabase 로 붙는 기본값을 코드에 적어 두었습니다.
// 다른 기관이 이 코드를 가져다 .env 를 빠뜨리고 배포하면 자기 데이터가 아니라 춘천
// 운영 데이터베이스에 붙게 되므로, 기본값을 비워 두었습니다. 재사용할 때는 자기
// 기관 Supabase 프로젝트의 값을 .env 에 넣으세요(.env.example 참고).
const FALLBACK_SUPABASE_URL = "";
const FALLBACK_SUPABASE_ANON_KEY = "";

const url = import.meta.env.VITE_SUPABASE_URL || FALLBACK_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || FALLBACK_SUPABASE_ANON_KEY;

// 값이 없을 때 여기서 멈추면(throw) 이 파일을 불러오는 테스트까지 함께 멈춥니다. 그래서
// 콘솔에 알리고, 어디에도 닿지 않는 주소로 만들어 둡니다 — 로그인·조회는 실패하지만 다른
// 기관의 데이터베이스로 붙는 일은 없습니다.
if (!url || !anonKey) {
  console.error(
    "Supabase 접속 정보가 없습니다. .env 에 VITE_SUPABASE_URL 과 VITE_SUPABASE_ANON_KEY 를 넣어 주세요(.env.example 참고).",
  );
}

export const supabase = createClient(
  url || "https://supabase-not-configured.invalid",
  anonKey || "not-configured",
);
