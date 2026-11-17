import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { fetchMyAccessStatus, submitAccessRequest } from "@/lib/requests";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CircleCheck, MessageSquarePlus } from "lucide-react";
import { BapsangMark } from "@/components/BapsangMark";
import { supabase } from "@/lib/supabase-client";
import { ALLOWED_EMAIL_DOMAIN } from "@/lib/use-session";
import { checkPassword, MIN_LENGTH, MIN_SPECIALS, SPECIAL_CHARS } from "@/lib/password-policy";

/**
 * 로그인하지 않은 사람에게 보이는 유일한 화면입니다.
 *
 * 어르신 이름·연락처·건강 메모가 담긴 화면이라 링크만으로 열려서는 안 됩니다. 그래서 앱
 * 전체를 이 화면 뒤에 두었고(__root.tsx), 실제 차단은 데이터베이스 정책이 합니다 — 로그인
 * 없이는 어떤 표도 읽히지 않습니다.
 *
 * 가입 신청은 신청자가 직접 비밀번호를 정하고 계정까지 만듭니다(auth.signUp). 비밀번호를
 * 신청 표에 담으면 그 표를 읽을 수 있는 사람이 남의 비밀번호를 평문으로 보게 되므로, 값을
 * 거치지 않고 Supabase Auth로 곧장 보내 해시로만 남게 합니다.
 *
 * 대신 "계정이 있다"와 "볼 권한이 있다"를 분리했습니다. 승인 전에는 로그인은 되지만 어떤
 * 표도 읽히지 않고(supabase/migration_010), 화면은 승인 대기 안내를 보여줍니다. 담당자가
 * 승인하면 본인이 정한 그 비밀번호로 바로 들어옵니다 — 담당자가 비밀번호를 대신 만들어
 * 전달할 일이 없습니다.
 */

// 왼쪽 패널에 그리는 출석 격자. 가로 한 줄이 어르신 한 분의 열흘이고, 칸 하나가 하루입니다.
// 초록은 나오신 날, 빨강은 안 나오신 날입니다.
//
// 특정 한 줄을 "연속 결석"으로 집어 보여주지 않습니다. 실제로 이 도구가 하는 일은 한 사람의
// 극적인 사건을 찾는 것이 아니라, 여러 사람의 열흘을 한꺼번에 놓고 평소와 달라진 결을 읽는
// 것입니다. 그래서 빨강을 여기저기 흩어, 이 자체가 읽어야 할 패턴으로 보이게 했습니다.
//
// 값을 난수로 만들지 않고 고정해 둔 이유: 서버에서 그린 화면과 브라우저에서 그린 화면이
// 달라지면 하이드레이션이 깨집니다.
// 비밀번호 규칙은 src/lib/password-policy.ts 한 곳에만 둡니다. 가입 화면과 재설정 화면이
// 서로 다른 기준을 쓰면, 재설정으로 규칙을 우회해 약한 비밀번호를 넣을 수 있습니다.

const ABSENT_DAYS: number[][] = [[7], [2, 8], [5, 6, 9], [1, 8], [4]];
const DAYS_PER_ROW = 10;

const MOTIF_TONES = {
  dark: {
    present: "bg-lime-200/55",
    absent: "bg-red-400/85",
    legendPresent: "bg-lime-200/75",
    legendAbsent: "bg-red-400/85",
    text: "text-lime-100/90",
    muted: "text-lime-100/70",
  },
  light: {
    present: "bg-emerald-300",
    absent: "bg-red-400",
    legendPresent: "bg-emerald-300",
    legendAbsent: "bg-red-400",
    text: "text-stone-600",
    muted: "text-stone-400",
  },
} as const;

function AttendanceMotif({
  tone = "dark",
  cell = "h-7 w-7",
  gap = "gap-2.5",
}: {
  tone?: keyof typeof MOTIF_TONES;
  cell?: string;
  gap?: string;
}) {
  const c = MOTIF_TONES[tone];
  return (
    <div aria-hidden="true">
      <div className={gap === "gap-2" ? "space-y-2" : "space-y-2.5"}>
        {ABSENT_DAYS.map((absent, r) => (
          <div key={r} className={`flex items-center ${gap}`}>
            {Array.from({ length: DAYS_PER_ROW }, (_, i) => (
              <span
                key={i}
                className={`${cell} rounded-[6px] ${absent.includes(i) ? c.absent : c.present}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className={`mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm ${c.text}`}>
        <span className="flex items-center gap-2">
          <span className={`h-4 w-4 rounded-[4px] ${c.legendPresent}`} />
          출석
        </span>
        <span className="flex items-center gap-2">
          <span className={`h-4 w-4 rounded-[4px] ${c.legendAbsent}`} />
          결석
        </span>
        <span className={c.muted}>패턴에서 신호를 읽습니다</span>
      </div>
    </div>
  );
}

/**
 * 화면 전체에 깔리는 배경.
 *
 * 예전에는 경로식당 식사 시간을 찍은 사진·영상을 깔았습니다. 어르신 얼굴이 알아볼 수
 * 있게 찍혀 있어, 저장소를 공개하면서 사진 없이 기관 색만 까는 방식으로 바꿨습니다.
 * 이 도구를 가져다 쓰는 기관은 동의받은 사진이 있다면 여기에 다시 넣으면 됩니다.
 */
function BackgroundScene() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[oklch(0.45_0.05_122)] via-[oklch(0.36_0.04_122)] to-[oklch(0.28_0.03_122)] opacity-80 lg:opacity-70"
    />
  );
}

/**
 * 비밀번호 조건을 **치는 동안** 보여줍니다.
 *
 * 조건을 다 치고 나서 "틀렸습니다"라고만 알려주면, 무엇이 모자란지 몰라 몇 번이고 다시
 * 치게 됩니다. 특히 특수문자 4개는 세면서 넣어야 하는 조건이라, 지금 몇 개인지 눈에
 * 보여야 합니다. 복지관 직원 연령대를 생각하면 더욱 그렇습니다.
 */
function PasswordRuleHint({ password }: { password: string }) {
  const check = checkPassword(password);
  const lengthOk = password.length >= MIN_LENGTH;
  const specialOk = check.specials >= MIN_SPECIALS;
  const mark = (ok: boolean) => (ok ? "text-emerald-700 font-semibold" : "text-stone-500");

  return (
    <div
      id="pw-rule"
      className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs leading-relaxed"
    >
      <p className="mb-1 font-semibold text-stone-700">비밀번호 조건</p>
      <p className={mark(lengthOk)}>
        {lengthOk ? "✓" : "·"} {MIN_LENGTH}자 이상
        {password.length > 0 && ` — 지금 ${password.length}자`}
      </p>
      <p className={mark(specialOk)}>
        {specialOk ? "✓" : "·"} 특수문자 {MIN_SPECIALS}개 이상
        {password.length > 0 && ` — 지금 ${check.specials}개`}
      </p>
      <p className="mt-1.5 text-stone-500">
        쓸 수 있는 특수문자: <span className="font-mono">{SPECIAL_CHARS.slice(0, 22)}</span> 등
      </p>
      <p className="mt-1 text-stone-500">
        외우기 쉽게 만드는 방법: 익숙한 말 사이사이에 같은 기호를 끼워 넣으면 조건이 한 번에
        채워집니다. 예: <span className="font-mono">밥상!위의!신호!2026!</span>
      </p>
    </div>
  );
}

export function LoginScreen() {
  const [mode, setMode] = useState<"login" | "request" | "requested">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reqName, setReqName] = useState("");
  const [reqNote, setReqNote] = useState("");
  const [reqPassword, setReqPassword] = useState("");
  const [reqPassword2, setReqPassword2] = useState("");
  // Supabase에서 "이메일 확인"이 켜져 있으면 가입 직후 로그인 상태가 되지 않고, 메일의 링크를
  // 눌러야 합니다. 그 경우에만 안내 문구가 한 줄 늘어납니다.
  const [needsEmailConfirm, setNeedsEmailConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const login = async () => {
    if (!email.trim() || !password) {
      toast.error("이메일과 비밀번호를 입력해주세요.");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setSubmitting(false);
    if (error) {
      toast.error("로그인에 실패했습니다. 이메일/비밀번호를 확인해주세요.");
    }
  };

  /**
   * 가입 신청 — 신청자가 정한 비밀번호로 계정을 만듭니다.
   *
   * 비밀번호를 신청 표에 저장하지 않고 signUp 으로 곧장 보내는 것이 요점입니다. Supabase Auth
   * 안에서 해시로만 보관되므로, 담당자도 다른 직원도 남의 비밀번호를 볼 수 없습니다.
   *
   * 승인 대기 신청서(access_requests)는 화면에서 따로 넣지 않습니다. 데이터베이스 트리거가
   * 계정 생성과 같은 트랜잭션에서 남깁니다(migration_010). 화면에서 두 번 나눠 저장하면,
   * 계정은 만들어졌는데 신청서 저장만 실패해 담당자 목록에 안 뜨는 계정이 생길 수 있습니다.
   */
  /**
   * 계정은 있는데 신청 기록이 없는 사람을 다시 신청 대기로 돌려놓습니다.
   *
   * 비밀번호로 본인임을 확인한 뒤에만 신청서를 만듭니다 — 남의 이메일로는 만들 수 없습니다.
   */
  const retryRequestForExistingAccount = async (address: string) => {
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: address,
      password: reqPassword,
    });
    if (signInError) {
      setSubmitting(false);
      toast.error(
        "이미 가입된 이메일입니다. 비밀번호가 맞지 않아 다시 신청할 수 없습니다 — 로그인하거나 비밀번호 재설정을 이용해주세요.",
        { duration: 9000 },
      );
      return;
    }
    const status = await fetchMyAccessStatus();
    if (status !== "none") {
      setSubmitting(false);
      toast.info(
        status === "approved"
          ? "이미 승인된 계정입니다. 그대로 이용하시면 됩니다."
          : "이미 신청이 접수돼 있습니다. 담당자 승인을 기다려주세요.",
      );
      return;
    }
    const { error: insertError } = await submitAccessRequest({
      email: address,
      name: reqName.trim(),
      note: reqNote.trim(),
    });
    setSubmitting(false);
    if (insertError) {
      toast.error("다시 신청하지 못했습니다. 담당자에게 알려주세요.");
      return;
    }
    setReqPassword("");
    setReqPassword2("");
    toast.success("다시 신청했습니다. 담당자 승인을 기다려주세요.");
    setMode("requested");
  };

  const signUpAndRequest = async () => {
    const address = email.trim().toLowerCase();
    if (!address || !reqName.trim()) {
      toast.error("기관 이메일과 이름을 입력해주세요.");
      return;
    }
    if (!address.endsWith(ALLOWED_EMAIL_DOMAIN)) {
      toast.error(`${ALLOWED_EMAIL_DOMAIN} 기관 이메일로만 신청할 수 있습니다.`);
      return;
    }
    const pwCheck = checkPassword(reqPassword);
    if (!pwCheck.ok) {
      toast.error(`비밀번호 조건이 맞지 않습니다 — ${pwCheck.problems.join(", ")}`);
      return;
    }
    if (reqPassword !== reqPassword2) {
      toast.error("두 번 입력한 비밀번호가 서로 다릅니다.");
      return;
    }

    setSubmitting(true);
    const { data, error } = await supabase.auth.signUp({
      email: address,
      password: reqPassword,
      options: {
        // 이름·소속은 계정에 딸린 메모로 넘깁니다. 트리거가 이 값을 읽어 신청서에 옮깁니다.
        data: { name: reqName.trim(), note: reqNote.trim() },
        emailRedirectTo: window.location.origin,
      },
    });
    setSubmitting(false);

    if (error) {
      const message = error.message.toLowerCase();
      if (message.includes("already registered") || message.includes("already been registered")) {
        // 계정은 남아 있는데 **신청 기록만 지워진** 경우가 있습니다.
        //
        // 담당자가 승인·반려 기록을 지우면 신청서는 사라지지만 로그인 계정은 그대로
        // 남습니다. 그러면 그 사람은 "이미 가입된 이메일"이라 다시 신청할 수도 없고,
        // 로그인해도 승인 기록이 없어 들어갈 수도 없는 **막다른 골목**에 갇힙니다.
        //
        // 그래서 비밀번호가 맞으면 본인으로 확인하고, 신청서만 새로 만들어 줍니다.
        // (비밀번호가 틀리면 남의 계정으로 신청서를 만들 수 없으니 그대로 막힙니다.)
        await retryRequestForExistingAccount(address);
        return;
      }
      if (message.includes("signup") && message.includes("disabled")) {
        // Supabase 쪽 가입 허용 설정이 꺼져 있을 때. 사용자가 고칠 수 없는 문제라 담당자에게
        // 연락하도록 안내합니다.
        toast.error("지금은 가입 신청을 받을 수 없는 상태입니다. 담당자에게 알려주세요.");
        return;
      }
      if (message.includes("password")) {
        toast.error("비밀번호가 조건에 맞지 않습니다. 더 길게, 다른 문자를 섞어 정해주세요.");
        return;
      }
      // Supabase 기본 메일 발송은 시간당 몇 건으로 제한됩니다. 한도를 넘으면 확인 메일을
      // 못 보내 가입 자체가 실패하고 계정도 만들어지지 않습니다. 신청자는 무엇이 잘못됐는지
      // 알 방법이 없으므로, 본인 잘못이 아니라는 것과 얼마나 기다려야 하는지를 알려줍니다.
      if (
        message.includes("rate limit") ||
        message.includes("security purposes") ||
        message.includes("only request this")
      ) {
        toast.error(
          "지금은 신청이 몰려 잠시 접수가 막혀 있습니다. 입력하신 내용은 그대로 두고 1시간 뒤에 다시 눌러주세요. 급하시면 담당자(033-241-5600)에게 연락해주세요.",
          { duration: 12000 },
        );
        return;
      }
      toast.error("신청을 보내지 못했습니다. 잠시 후 다시 시도해주세요.");
      return;
    }

    // 비밀번호는 화면 상태에도 남기지 않습니다.
    setReqPassword("");
    setReqPassword2("");

    // 세션이 함께 오면 그대로 로그인된 상태입니다 — 이 경우 화면은 앱 바깥의 승인 대기
    // 화면(__root.tsx)으로 자동 전환되므로 여기서 따로 안내하지 않습니다.
    if (data.session) return;
    setNeedsEmailConfirm(true);
    setMode("requested");
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-stone-50 lg:grid lg:grid-cols-[1.05fr_1fr]">
      {/* 배경 — 화면 전체에 깔고, 좌우 칼럼이 각자 다른 막을 덮습니다. */}
      <BackgroundScene />

      {/* ── 왼쪽: 브랜드 패널 (넓은 화면에서만) ────────────────────────
          로그인 화면은 코치·심사위원이 가장 먼저 보는 화면이기도 해서, 무엇을 하는
          도구인지 한 번은 말해주는 자리로 씁니다. */}
      <div className="relative hidden overflow-hidden p-12 lg:flex lg:flex-col lg:justify-between">
        {/* 글씨가 놓이는 왼쪽 아래로 갈수록 어둡게 눌러 대비를 지킵니다. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-[oklch(0.22_0.025_122)]/95 via-[oklch(0.22_0.025_122)]/72 to-[oklch(0.22_0.025_122)]/30"
        />

        {/* 배경 무늬는 직접 그립니다(as="svg"). 아주 옅은 선 하나로 깔아야 하는데,
            원본 PNG 를 5% 로 깔면 그림 전체가 뿌옇게 비칩니다. */}
        <BapsangMark
          as="svg"
          className="pointer-events-none absolute -bottom-24 -right-20 h-[32rem] w-[32rem] text-lime-200/[0.05]"
          signalClassName="text-lime-200/[0.05]"
          strokeWidth={0.7}
        />

        <div className="relative flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-lime-100/10">
            {/* 짙은 초록 패널 위라 직접 그립니다 — 원본은 검은 선이라 여기서는
                안 보입니다. 형태는 같고 색만 밝게 받습니다. */}
            <BapsangMark
              as="svg"
              className="h-7 w-7 text-lime-50"
              signalClassName="text-red-400"
              strokeWidth={2.5}
            />
          </span>
          <span className="text-base font-semibold tracking-tight text-lime-50">밥상위의 신호</span>
        </div>

        <div className="relative max-w-md">
          <p className="text-xs font-medium tracking-[0.18em] text-lime-200/90">
            춘천남부노인복지관
          </p>
          <h1 className="mt-4 text-[2.4rem] font-bold leading-[1.22] tracking-tight text-lime-50 [text-shadow:0_1px_12px_oklch(0.2_0.02_122/0.55)]">
            어르신이 밥상에 앉지 않는 날,
            <br />
            그것부터 신호입니다.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-lime-100/90">
            급식 출결에서 그분의 평소 리듬이 흔들리는 순간을 찾아, 위기가 사고가 되기 전에 먼저
            찾아뵙기 위한 도구입니다.
          </p>

          <div className="mt-9">
            <AttendanceMotif />
          </div>
        </div>

        {/* 기관 로고는 흰 종이용 녹색 로고라 어두운 패널에 그대로 올리면 거의 보이지
            않습니다. 그래서 밝은 바탕이 필요한데, 로고만 담은 작은 상자는 떠 있는 것처럼
            보입니다. 패널 패딩을 밀어내 좌우 끝까지 닿는 띠로 만들고 기관 정보를 함께
            넣어, 편지지 하단처럼 의도된 구역으로 읽히게 했습니다. */}
        <div className="relative -mx-12 -mb-12 mt-12 flex flex-col gap-2.5 bg-stone-50 px-12 py-7">
          <img
            src="/brand/ccnoin-logo.png"
            alt="춘천남부노인복지관"
            /* self-start 가 없으면 세로 flex의 기본값(stretch) 때문에 가로로 늘어납니다. */
            className="h-11 w-auto self-start"
            width={800}
            height={135}
          />
          <p className="text-[13px] leading-relaxed text-stone-500">
            <span className="font-medium text-stone-700">
              진실한 섬김
              <span className="mx-1.5 font-normal text-stone-300">·</span>
              사회적 돌봄
              <span className="mx-1.5 font-normal text-stone-300">·</span>
              변화와 혁신
            </span>
            <br />
            디아코니아로 행복한 세상을 만들어갑니다.
            <br />
            033-241-5600
            {/* 로그인 전에도 닿아야 합니다 — 승인 대기 중인 직원도, 감사 나온 분도
                이 화면에서 멈춥니다. */}
            <br />
            <Link to="/privacy" className="underline underline-offset-2 hover:text-white">
              개인정보 처리방침
            </Link>
          </p>
        </div>
      </div>

      {/* ── 오른쪽: 로그인 ──────────────────────────────────────── */}
      {/* 넓은 화면에서는 왼쪽 패널이 배경색을 보여주므로 이쪽은 고르게 하얀 막을 덮습니다.
          그런데 좁은 화면에서는 왼쪽 패널이 숨겨져 이 칼럼이 화면 전체가 되고, 그러면 같은
          막이 배경을 통째로 가려버립니다. 그래서 좁은 화면에서는 위(로고·제목 자리)를 얇게,
          아래(입력칸 자리)로 갈수록 두껍게 덮어 배경은 보이면서 글씨는 읽히게 합니다. */}
      <div className="relative flex min-h-screen flex-col justify-center bg-gradient-to-b from-white/35 via-white/88 to-white/97 px-6 py-14 backdrop-blur-[5px] lg:min-h-0 lg:bg-white/78 lg:bg-none lg:px-14 lg:backdrop-blur-xl">
        <div className="mx-auto w-full max-w-[26rem]">
          {/* 좁은 화면에서는 왼쪽 패널이 없으니 로고를 여기서 보여줍니다. */}
          <div className="mb-8 flex flex-col items-center gap-4 text-center lg:hidden">
            <img
              src="/brand/ccnoin-logo.png"
              alt="춘천남부노인복지관"
              className="h-10 w-auto"
              width={800}
              height={135}
            />
            <div className="flex flex-col items-center gap-2.5">
              <span className="flex h-18 w-18 items-center justify-center rounded-2xl bg-primary/[0.07] p-3">
                <BapsangMark className="h-full w-full text-primary" />
              </span>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">밥상위의 신호</h1>
                <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                  식사 출결 데이터 패턴 분석으로
                  <br />
                  어르신 위기 신호를 조기에 발견합니다
                </p>
              </div>
            </div>
          </div>

          {/* 넓은 화면에서는 왼쪽 패널이 기관을 말해주므로, 이쪽에는 제품 표시만 얹어
              칼럼이 시작되는 지점을 만들어 줍니다(좁은 화면은 위 블록이 대신합니다). */}
          <div className="mb-9 hidden items-center gap-4 lg:flex">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/[0.07]">
              <BapsangMark className="h-10 w-10 text-primary" />
            </span>
            <div>
              <div className="text-2xl font-bold tracking-tight">밥상위의 신호</div>
              <div className="mt-1.5 text-[15px] leading-snug text-muted-foreground">
                식사 출결 데이터 패턴 분석으로
                <br />
                어르신 위기 신호를 조기에 발견합니다
              </div>
            </div>
          </div>

          {mode === "requested" ? (
            <div>
              <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50">
                <CircleCheck className="h-6 w-6 text-emerald-600" />
              </span>
              <h2 className="text-xl font-bold tracking-tight">가입 신청이 접수되었습니다</h2>
              <div className="mt-3.5 space-y-3 text-base leading-relaxed text-muted-foreground">
                {needsEmailConfirm && (
                  <p>
                    먼저 <b className="font-medium text-foreground">신청하신 이메일함</b>을 확인해
                    주세요. 확인 메일의 링크를 한 번 눌러야 신청이 완료됩니다.
                  </p>
                )}
                <p>
                  비밀번호는 방금 정하신 그대로 쓰시면 됩니다. 다만 바로 사용할 수 있는 것은 아니고,{" "}
                  <b className="font-medium text-foreground">관리자가 승인해야</b> 어르신 정보가
                  보입니다.
                </p>
                <p>
                  승인까지 시간이 걸릴 수 있으니 조금만 기다려 주세요. 승인 전에 로그인하시면 대기
                  중이라는 안내 화면이 보입니다.
                </p>
                <p className="text-xs">급하시면 담당자에게 직접 연락해주세요.</p>
              </div>
              <Button
                variant="outline"
                className="mt-6 w-full"
                onClick={() => {
                  setMode("login");
                  setPassword("");
                  setReqName("");
                  setReqNote("");
                  setReqPassword("");
                  setReqPassword2("");
                  setNeedsEmailConfirm(false);
                }}
              >
                로그인 화면으로
              </Button>
            </div>
          ) : (
            <div>
              <h2 className="text-[1.85rem] font-bold tracking-tight">
                {mode === "login" ? "로그인" : "가입 신청"}
              </h2>
              <p className="mt-2.5 text-base leading-relaxed text-muted-foreground">
                {mode === "login"
                  ? "어르신 개인정보가 담긴 화면이라 로그인한 직원만 볼 수 있습니다."
                  : `${ALLOWED_EMAIL_DOMAIN} 기관 이메일과 앞으로 쓰실 비밀번호를 정해 신청해주세요. 관리자가 승인하면 그 비밀번호로 바로 로그인됩니다.`}
              </p>

              <div className="mt-7 space-y-3">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={
                    mode === "login" ? "이메일" : `기관 이메일 (${ALLOWED_EMAIL_DOMAIN})`
                  }
                  className="h-14 text-base"
                  autoFocus
                />
                {mode === "login" ? (
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && login()}
                    placeholder="비밀번호"
                    className="h-14 text-base"
                  />
                ) : (
                  <>
                    <Input
                      value={reqName}
                      onChange={(e) => setReqName(e.target.value)}
                      placeholder="이름"
                      className="h-14 text-base"
                    />
                    {/* 비밀번호는 여기서 받아 Supabase Auth로 곧장 보냅니다. 신청 표에는
                        저장하지 않습니다 — 그러면 그 표를 읽는 사람이 평문으로 보게 됩니다. */}
                    <Input
                      type="password"
                      value={reqPassword}
                      onChange={(e) => setReqPassword(e.target.value)}
                      placeholder="앞으로 쓰실 비밀번호"
                      autoComplete="new-password"
                      className="h-14 text-base"
                      aria-describedby="pw-rule"
                    />
                    <PasswordRuleHint password={reqPassword} />
                    <Input
                      type="password"
                      value={reqPassword2}
                      onChange={(e) => setReqPassword2(e.target.value)}
                      placeholder="비밀번호 한 번 더"
                      autoComplete="new-password"
                      className="h-14 text-base"
                    />
                    <Textarea
                      value={reqNote}
                      onChange={(e) => setReqNote(e.target.value)}
                      placeholder="소속 과·팀 (예: 복지2과 사회참여팀)"
                      className="min-h-24 text-base"
                    />
                    <p className="pt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                      어르신 개인정보를 다루는 계정입니다. 다른 곳에서 쓰는 비밀번호를 그대로 쓰지
                      말아주세요.
                    </p>
                  </>
                )}
              </div>

              <Button
                className="mt-6 h-14 w-full text-[17px] font-semibold"
                onClick={mode === "login" ? login : signUpAndRequest}
                disabled={submitting}
              >
                {mode === "login" ? "로그인" : "가입 신청하기"}
              </Button>

              {/* 「재설정 메일 받기」 단추를 뺐습니다.
                  기관에서 메일 발송을 쓰지 않기로 해, 눌러도 아무 일이 일어나지 않는
                  단추였습니다. 안 되는 단추를 남겨두면 잊으신 분이 그것만 몇 번 누르다
                  포기합니다. 어디로 가야 하는지 대신 적습니다 — 담당자가 관리자 화면에서
                  다시 만들어 드릴 수 있습니다. */}
              {mode === "login" && (
                <p className="mt-3.5 text-center text-sm text-muted-foreground">
                  비밀번호를 잊으셨으면 담당자에게 말씀해 주세요.
                </p>
              )}

              <div className="mt-6 border-t pt-5">
                <button
                  type="button"
                  className="w-full text-center text-[15px] text-muted-foreground hover:text-foreground hover:underline"
                  onClick={() => setMode(mode === "login" ? "request" : "login")}
                >
                  {mode === "login"
                    ? "계정이 없으신가요? 가입 신청하기"
                    : "이미 계정이 있으신가요? 로그인"}
                </button>
              </div>
            </div>
          )}

          <Link
            to="/suggest"
            className="mt-7 flex items-center justify-center gap-2 text-[15px] text-muted-foreground hover:text-foreground hover:underline"
          >
            <MessageSquarePlus className="h-4 w-4" />
            건의·문의하기
          </Link>

          {/* 좁은 화면에서는 왼쪽 브랜드 패널이 숨겨지므로 같은 내용을 여기 둡니다.
              폼 위가 아니라 아래인 이유: 휴대폰에서 로그인 버튼이 첫 화면 밖으로 밀리면
              매일 로그인하는 직원에게 불편해집니다. */}
          <div className="mt-10 border-t pt-8 lg:hidden">
            <h2 className="text-xl font-bold leading-snug tracking-tight">
              어르신이 밥상에 앉지 않는 날,
              <br />
              그것부터 신호입니다.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              급식 출결에서 그분의 평소 리듬이 흔들리는 순간을 찾아, 위기가 사고가 되기 전에 먼저
              찾아뵙기 위한 도구입니다.
            </p>
            <div className="mt-6">
              <AttendanceMotif tone="light" cell="h-6 w-6" gap="gap-2" />
            </div>
            <img
              src="/brand/ccnoin-logo.png"
              alt="춘천남부노인복지관"
              className="mt-8 h-9 w-auto"
              width={800}
              height={135}
            />
            <p className="mt-2.5 text-xs leading-relaxed text-stone-500">
              <span className="font-medium text-stone-700">
                진실한 섬김
                <span className="mx-1.5 font-normal text-stone-300">·</span>
                사회적 돌봄
                <span className="mx-1.5 font-normal text-stone-300">·</span>
                변화와 혁신
              </span>
              <br />
              디아코니아로 행복한 세상을 만들어갑니다.
              <br />
              033-241-5600
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
