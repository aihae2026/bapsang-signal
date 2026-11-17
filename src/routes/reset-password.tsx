import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CircleCheck, KeyRound } from "lucide-react";
import { BapsangMark } from "@/components/BapsangMark";
import { supabase } from "@/lib/supabase-client";
import { checkPassword, MIN_LENGTH, MIN_SPECIALS, PASSWORD_HINT } from "@/lib/password-policy";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "비밀번호 재설정 | 밥상위의 신호" },
      { name: "description", content: "직원 계정의 비밀번호를 직접 설정합니다." },
      { property: "og:title", content: "비밀번호 설정" },
      { property: "og:description", content: "직원 계정 비밀번호 설정." },
    ],
  }),
  component: ResetPasswordPage,
});

// 규칙은 password-policy.ts 한 곳에 있습니다 — 재설정 화면만 느슨하면 그쪽으로
// 약한 비밀번호를 넣어 가입 화면의 규칙을 우회할 수 있습니다.

/**
 * 비밀번호 재설정 화면.
 *
 * 비밀번호를 잊었을 때 쓰는 화면입니다. 가입할 때는 신청자가 신청 양식에서 직접 비밀번호를
 * 정하므로(LoginScreen), 이 화면을 반드시 거쳐야 하는 것은 아닙니다.
 *
 * 어느 경로든 비밀번호는 access_requests 표를 거치지 않고 Supabase Auth로 곧장 갑니다. 표에
 * 담으면 그 표를 읽을 수 있는 사람이 남의 비밀번호를 평문으로 보게 되고, 백업·로그에도 그대로
 * 남습니다. Auth 안에서는 해시로만 보관됩니다.
 *
 * 메일의 링크를 누르면 Supabase가 복구 세션을 만들어 주고, 그 상태에서 updateUser로
 * 비밀번호를 바꿉니다. 링크 없이 이 주소로 바로 들어오면 세션이 없으므로 안내만 합니다.
 */
function ResetPasswordPage() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // 메일 링크로 들어왔는지 확인합니다. Supabase가 주소의 토큰을 세션으로 바꾸는 데
    // 잠깐 걸리므로, 인증 상태 변화도 함께 듣습니다.
    supabase.auth.getSession().then(({ data }) => setReady(!!data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const submit = async () => {
    const check = checkPassword(password);
    if (!check.ok) {
      toast.error(`비밀번호 조건이 맞지 않습니다 — ${check.problems.join(", ")}`);
      return;
    }
    if (password !== confirm) {
      toast.error("두 번 입력한 비밀번호가 서로 다릅니다.");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (error) {
      toast.error("설정하지 못했습니다. 메일의 링크가 만료되었을 수 있습니다.");
      return;
    }
    setDone(true);
  };

  return (
    <div className="min-h-screen bg-stone-50">
      <main className="mx-auto flex max-w-sm flex-col px-6 py-16">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/[0.07] p-2.5">
            <BapsangMark className="h-full w-full text-primary" />
          </span>
          <h1 className="text-xl font-bold tracking-tight">밥상위의 신호</h1>
        </div>

        {done ? (
          <Card className="p-6 text-center">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50">
              <CircleCheck className="h-6 w-6 text-emerald-600" />
            </span>
            <h2 className="text-lg font-bold tracking-tight">비밀번호를 설정했습니다</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
              이제 이 비밀번호로 로그인할 수 있습니다.
            </p>
            <Button className="mt-6 h-12 w-full" asChild>
              <Link to="/dashboard">시작하기</Link>
            </Button>
          </Card>
        ) : ready === false ? (
          <Card className="p-6 text-center">
            <h2 className="text-lg font-bold tracking-tight">링크를 통해 들어와주세요</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
              재설정 메일의 링크를 눌러야 이 화면에서 비밀번호를 정할 수 있습니다. 로그인 화면에서
              &ldquo;비밀번호를 잊으셨나요?&rdquo;를 눌러 메일을 받아주세요.
            </p>
            <Button variant="outline" className="mt-6 h-12 w-full" asChild>
              <Link to="/dashboard">로그인 화면으로</Link>
            </Button>
          </Card>
        ) : (
          <Card className="p-6">
            <div className="mb-5 flex flex-col items-center gap-2 text-center">
              <KeyRound className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-bold tracking-tight">비밀번호 재설정</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                앞으로 로그인할 때 쓰실 비밀번호를 직접 정해주세요.
              </p>
            </div>

            <Label className="mb-1.5 block text-xs">
              새 비밀번호 ({MIN_LENGTH}자 이상 · 특수문자 {MIN_SPECIALS}개 이상)
            </Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-12 text-base"
              autoFocus
            />
            <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
              {checkPassword(password).ok ? "✓ 조건을 모두 채웠습니다." : PASSWORD_HINT}
            </p>
            <Label className="mb-1.5 mt-4 block text-xs">한 번 더 입력</Label>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              className="h-12 text-base"
            />
            <Button
              className="mt-6 h-12 w-full text-base font-semibold"
              onClick={submit}
              disabled={submitting || ready === null}
            >
              {ready === null ? "확인 중입니다..." : "이 비밀번호로 설정"}
            </Button>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              어르신 개인정보를 다루는 계정입니다. 다른 곳에서 쓰는 비밀번호를 그대로 쓰지
              말아주세요.
            </p>
          </Card>
        )}
      </main>
    </div>
  );
}
