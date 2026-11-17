// 비밀번호 규칙.
//
// 어르신 396명의 출결·건강 관찰 기록이 들어 있는 시스템입니다. 계정 하나가 뚫리면 그 전부가
// 나갑니다. 그래서 기관 방침으로 **10자 이상 · 특수문자 4개 이상**을 요구합니다.
//
// ⚠️ 이 파일은 화면에서 미리 걸러주는 1차 안내입니다. 가입 API를 화면 없이 직접 부르면
//    여기를 거치지 않으므로, 서버(Supabase 대시보드)에도 하한을 걸어야 합니다:
//    Authentication → Sign In/Providers → Email 의 "Minimum password length(12)" +
//    "Password Requirements(문자 종류 필수)", 그리고 Attack Protection의 "Leaked password
//    protection" 켜기. 상세 절차는 리포지토리 루트 `보안-비밀번호-서버설정.md` 참고.
//    (Supabase는 "특수문자 4개"까지는 서버 강제 불가라, 그 규칙은 이 화면 정책으로 유지)
//
// 왜 "특수문자 4개"인가에 대한 참고: 국제 표준(NIST SP 800-63B)은 이런 구성 규칙보다 길이를
// 권합니다. 규칙이 까다로우면 사람들이 비밀번호를 적어두기 때문입니다. 그래서 아래 안내문은
// 규칙을 나열하는 대신 **규칙을 지키면서 외우기 쉬운 예시**를 보여주는 쪽으로 썼습니다.

export const MIN_LENGTH = 10;
export const MIN_SPECIALS = 4;

// 키보드로 바로 칠 수 있는 기호만 셉니다. 한글 자판에서 특수문자를 넣기 어려워하시는 분이
// 많아, "무엇이 특수문자인지"를 화면에 그대로 보여줄 수 있어야 합니다.
export const SPECIAL_CHARS = "!@#$%^&*()-_=+[]{};:,.<>?/~`|'\"";

function countSpecials(pw: string): number {
  let n = 0;
  for (const ch of pw) if (SPECIAL_CHARS.includes(ch)) n++;
  return n;
}

export interface PasswordCheck {
  ok: boolean;
  length: number;
  specials: number;
  /** 아직 못 지킨 조건. 화면에 그대로 보여줍니다. */
  problems: string[];
}

export function checkPassword(pw: string): PasswordCheck {
  const specials = countSpecials(pw);
  const problems: string[] = [];
  if (pw.length < MIN_LENGTH) problems.push(`${MIN_LENGTH}자 이상 (지금 ${pw.length}자)`);
  if (specials < MIN_SPECIALS)
    problems.push(`특수문자 ${MIN_SPECIALS}개 이상 (지금 ${specials}개)`);
  // 공백만으로 자릿수를 채우는 것을 막습니다. 규칙은 지켰지만 실제로는 약한 비밀번호입니다.
  if (pw.trim().length < pw.length - 2) problems.push("앞뒤 공백은 빼주세요");
  return { ok: problems.length === 0, length: pw.length, specials, problems };
}

/** 입력 칸 아래에 늘 띄워두는 안내문. */
export const PASSWORD_HINT = `${MIN_LENGTH}자 이상, 특수문자 ${MIN_SPECIALS}개 이상 (예: 밥상!위의!신호!2026!)`;
