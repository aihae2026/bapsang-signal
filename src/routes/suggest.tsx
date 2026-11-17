import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CircleCheck, MessageSquarePlus } from "lucide-react";
import { BapsangMark } from "@/components/BapsangMark";
import { NavBar } from "@/components/NavBar";
import { submitSuggestion, type SuggestionCategory } from "@/lib/requests";

export const Route = createFileRoute("/suggest")({
  head: () => ({
    meta: [
      { title: "건의·문의 | 밥상위의 신호" },
      {
        name: "description",
        content: "프로그램에 대한 건의사항이나 질문, 오류를 관리자에게 전달합니다.",
      },
      { property: "og:title", content: "건의·문의" },
      { property: "og:description", content: "관리자에게 건의사항과 질문을 남깁니다." },
    ],
  }),
  component: SuggestPage,
});

const CATEGORIES: SuggestionCategory[] = ["건의", "질문", "오류 신고"];

const PLACEHOLDERS: Record<SuggestionCategory, string> = {
  건의: "예: 관리군 목록을 담당 직원별로도 볼 수 있으면 좋겠습니다.",
  질문: "예: 출석률이 낮은데 위기로 안 잡히는 어르신은 왜 그런가요?",
  "오류 신고": "예: 어르신 상세 화면에서 6월 달력이 비어 있습니다.",
};

function SuggestPage() {
  const [category, setCategory] = useState<SuggestionCategory>("건의");
  const [author, setAuthor] = useState("");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const send = async () => {
    if (!text.trim()) {
      toast.error("내용을 입력해주세요.");
      return;
    }
    setSubmitting(true);
    const { error } = await submitSuggestion({ author, category, text });
    setSubmitting(false);
    if (error) {
      toast.error("전달하지 못했습니다. 잠시 후 다시 시도해주세요.");
      return;
    }
    setSent(true);
  };

  return (
    <div className="min-h-screen bg-stone-50">
      <NavBar />
      <main className="mx-auto flex max-w-lg flex-col px-6 py-12">
        <div className="mb-6 flex flex-col items-center gap-2.5 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/[0.07] p-1.5">
            <BapsangMark className="h-full w-full text-primary" />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">건의·문의</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              쓰면서 불편했던 점, 궁금한 점, 잘못 나오는 화면을 알려주세요.
            </p>
          </div>
        </div>

        {sent ? (
          <Card className="p-6 text-center">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50">
              <CircleCheck className="h-6 w-6 text-emerald-600" />
            </span>
            <h2 className="text-base font-semibold">전달되었습니다</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              관리자가 관리자 설정 화면에서 확인합니다. 답변이 필요한 내용이면 담당자가 따로
              연락드립니다.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSent(false);
                  setText("");
                  setCategory("건의");
                }}
              >
                하나 더 보내기
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/dashboard">대시보드로 돌아가기</Link>
              </Button>
            </div>
          </Card>
        ) : (
          <Card className="p-6">
            <Label className="mb-1.5 block text-xs">분류</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as SuggestionCategory)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label className="mb-1.5 mt-4 block text-xs">이름 (선택)</Label>
            <Input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="비워두면 익명으로 전달됩니다"
            />

            <Label className="mb-1.5 mt-4 block text-xs">내용</Label>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={PLACEHOLDERS[category]}
              className="min-h-32"
            />

            {/* 이 칸은 로그인 없이 누구나 쓸 수 있습니다. 어르신 실명이나 연락처가 섞여 들어가면
                권한 없는 사람이 남긴 글에 개인정보가 담기게 되므로 미리 안내합니다. */}
            <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
              어르신 실명·연락처는 적지 말아주세요. 특정 어르신에 관한 내용이면 &ldquo;A-27
              어르신&rdquo;처럼 번호로 적어주시면 됩니다.
            </p>

            <Button className="mt-4 w-full" onClick={send} disabled={submitting}>
              <MessageSquarePlus className="mr-1.5 h-4 w-4" />
              보내기
            </Button>
          </Card>
        )}
      </main>
    </div>
  );
}
