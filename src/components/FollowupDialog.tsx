import { useState, useRef } from "react";
import { toast } from "sonner";
import { Check, CircleCheck, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { RiskBadge } from "@/components/RiskBadge";
import { residentLabel } from "@/components/ResidentName";
import {
  classifyFollowupNote,
  withinHalfYear,
  type StructuredResult,
} from "@/lib/followup-classify";
import { classifyWithAi, maskNames } from "@/lib/ai-assessment";
import { useStaffName } from "@/lib/use-session";
import {
  REACTION_META,
  RESULT_KIND_META,
  getNoteContext,
  suggestSnoozeDays,
  addFollowup,
  deleteFollowup,
  getFollowupsForResident,
  isClosedFollowup,
  isPausedFollowup,
  updateFollowup,
  type AiRiskAssessment,
  type Followup,
  type FollowupReaction,
  type FollowupOutcome,
  type NoteContext,
  type Resident,
  type ResultKind,
} from "@/lib/attendance-engine";

// 담당자가 위기·주의 어르신을 확인한 결과를 남기는 창입니다.
// "확인해보니 실제로 개입이 필요했는지"를 받아 두면, 나중에 AI 판단이 얼마나 맞았는지
// 숫자로 말할 수 있게 됩니다.
// 개입 이력 패널 — 지난 확인 기록을 읽고, 잘못 기록한 건을 고치고, 새로 확인한 결과를 더합니다.
// "한 번 확인하면 끝"이 아닌 이유: 1차에서 지금은 괜찮으심였던 어르신이 몇 달 뒤 다시 위험군에
// 오르는 일이 흔하고, 그때는 지난번에 왜 불필요였는지를 읽어야 이번 판단을 할 수 있습니다.
//
// 메인 대시보드와 간단 보기(/today)가 같은 창을 씁니다.
export function FollowupDialog({
  target,
  onClose,
  checkedAt,
  dataAsOf,
  canRecord,
}: {
  target: { resident: Resident; assessment: AiRiskAssessment } | null;
  onClose: () => void;
  /** 기록에 남길 날짜 = **적은 날(오늘)**. */
  checkedAt: string;
  /** 판정이 서 있는 **자료 기준일**. 급식 자료가 하루 늦게 들어와 오늘과 다릅니다. */
  dataAsOf: string;
  canRecord: boolean;
}) {
  // 기록에 적힐 이름 = 지금 로그인한 사람(가입할 때 적은 이름).
  const staff = useStaffName();
  const [note, setNote] = useState("");
  // 기본 2개월. 현장에서 "농사철 지나고" "겨울 나고" 처럼 계절 단위로 쉬시는 분이 많아
  // 주 단위로는 매번 다시 떴습니다. 프리셋은 2개월 단위(2·4·6·8·10·12)로 둡니다.
  const [snoozeDays, setSnoozeDays] = useState(61);
  const [snoozeDate, setSnoozeDate] = useState(""); // 복귀 예정일 직접 지정(있으면 프리셋보다 우선)
  // 8-1: 자유 입력 → 분류 미리보기 → 담당자 확인. 자동 적용하지 않습니다.
  const [preview, setPreview] = useState<StructuredResult | null>(null);
  const [pickedKind, setPickedKind] = useState<ResultKind | null>(null);
  const [pickedResume, setPickedResume] = useState("");
  // AI가 읽는 중인지 / 왜 그렇게 봤는지. 규칙이 헷갈려 할 때만 부릅니다.
  const [aiThinking, setAiThinking] = useState(false);
  const [aiOut, setAiOut] = useState<{
    situation: string;
    nextAction: string;
    watchOut: string;
    reason: string;
    /** AI 가 스스로 매긴 확신도. 예전에는 받아만 두고 아무 데서도 안 썼습니다. */
    confidence?: "high" | "low";
  } | null>(null);
  // 적어주신 말에 붙는 부가 자료 — "추석 기간 2026-09-24 ~ 26" 같은 것들
  const [context, setContext] = useState<NoteContext[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 어르신 반응. 기본은 안 고름(null) — 억지로 고르게 하면 아무 뜻이 없어집니다.
  const [reaction, setReaction] = useState<FollowupReaction>(null);
  // 반응을 한 줄로. 단추가 「어느 쪽인가」라면 이 칸은 「왜 그러셨나」입니다.
  // "불편해하심"이 전화가 귀찮으셨던 것인지 감시받는 기분이셨던 것인지는 완전히 다른
  // 이야기인데, 단추 하나로는 갈라지지 않습니다.
  const [reactionNote, setReactionNote] = useState("");
  const editStaff = staff;
  const [editNote, setEditNote] = useState("");
  /** 수정 중인 기록의 「다음 확인 시점」. null 이면 기본 기한으로 돌아갑니다. */
  const [editSnooze, setEditSnooze] = useState<string | null>(null);
  /** 수정 중인 기록의 어르신 반응. 잘못 누른 값을 고칠 길이 아예 없었습니다. */
  const [editReaction, setEditReaction] = useState<FollowupReaction>(null);
  const [editReactionNote, setEditReactionNote] = useState("");

  const history = target ? getFollowupsForResident(target.resident.id) : [];

  const closeAll = () => {
    setNote("");
    // ★ 반응도 비웁니다. 예전에는 안 비웠습니다 — 김 어르신께 「반가워하심」을 누르고
    //    창을 닫은 뒤 박 어르신 창을 열면 그 단추가 **눌린 채로** 떠 있었습니다.
    //    그대로 저장하면 통화한 적도 없는 반응이 남습니다. 표본이 오염되면 한 해 치를
    //    모아도 쓸 수 없습니다.
    setReaction(null);
    setReactionNote("");
    setEditSnooze(null);
    setPreview(null);
    setPickedKind(null);
    setPickedResume("");
    setAiOut(null);
    setContext([]);
    setEditingId(null);
    onClose();
  };

  // 메모를 읽어 분류를 제안합니다. 반영은 담당자가 아래에서 확인 버튼을 눌러야 됩니다.
  //
  // 두 단계로 봅니다.
  //   ① 규칙(정규식)  — 즉시, 공짜. "연락 안 됨", "요양원 입소" 처럼 또렷한 말을 잡습니다.
  //   ② AI            — 규칙이 못 잡았을 때만. 한 건 2원.
  //
  // 규칙을 안 버리는 이유: 대부분은 규칙으로 충분하고, AI가 안 되는 날에도 기록은 남아야
  // 합니다. AI를 얹는 이유: 사람이 쓰는 말을 규칙으로 다 막을 수 없습니다 — 실제로
  // "특이사항 없음"의 '특이사항'을 '이사'로 읽어 어르신을 앞으로 확인 대상에서 제외시킨 적이 있습니다.
  const runClassify = async () => {
    const r = classifyFollowupNote(note, checkedAt);
    const ctx = getNoteContext(note, checkedAt);
    setContext(ctx);
    // ⚠️ 우리 달력이 준 날짜도 **그물을 통과시킵니다.**
    //
    //    fromCtx 는 지금까지 무조건 우선권이었고, withinHalfYear 를 거치지 않았습니다.
    //    그래서 과거 날짜(지나간 연휴)나, 공휴일 표에 다음 해를 넣는 순간 생기는
    //    11개월짜리 미래 날짜가 그대로 들어갔습니다. 규칙 경로와 AI 경로에는 그물이
    //    있는데 이 경로만 없었습니다 — 같은 값을 다루는 세 길의 기준을 맞춥니다.
    const fromCtx =
      withinHalfYear(ctx.find((c) => c.suggestedResume)?.suggestedResume ?? null, checkedAt) ??
      undefined;

    const apply = (kind: ResultKind, resume: string | null) => {
      setPickedKind(kind);
      setPickedResume(resume ?? fromCtx ?? "");
      const days = suggestSnoozeDays(kind);
      if (days > 0) {
        setSnoozeDays(days);
        setSnoozeDate("");
      }
    };

    setPreview(r);
    // 우리 달력(fromCtx)을 먼저 씁니다.
    //
    // 예전에는 규칙이 낸 날짜를 먼저 썼는데, 규칙은 명절을 "오늘 + 21일"로 짐작해
    // 2026 추석에 10/07 을 냈습니다(정답 9/28). AI 가 성공할 때만 정확한 날짜로 덮이니,
    // **AI 가 꺼져 있으면 9일 늦게 발견**하게 됩니다. 사양 8장은 "LLM 실패 시에도 핵심
    // 동작해야 함"이라, 정확한 날짜가 AI 에 달려 있으면 안 됩니다.
    apply(r.resultKind, fromCtx ?? r.resumeExpected);

    // ★ 규칙이 확신해도 AI 를 부릅니다 — **갈래가 아니라 글 때문입니다.**
    //
    //   예전에는 여기서 `if (r.confidence !== "low") return;` 으로 끝냈습니다. 규칙이
    //   확신하면 AI 를 부를 이유가 없다고 본 것인데, 그건 AI 가 **갈래만 고른다**고
    //   여겼을 때의 이야기입니다. AI 가 실제로 내놓는 것은 넷입니다 —
    //
    //     갈래         ← 규칙이 이미 잘합니다
    //     상황 정리    ← 흩어 적은 것을 「언제 → 무슨 일 → 지금 어떤 상태」로 꿰어 줍니다
    //     다음 할 일   ← 담당자가 오늘 무엇을 해야 하는지
    //     놓치기 쉬운 점 ← 기록에 안 적힌 것, 나빠질 낌새
    //
    //   뒤의 셋은 규칙이 못 합니다. 그런데 규칙이 잘 맞힐수록 AI 를 안 부르니,
    //   **또렷하게 적을수록 도움말이 줄어드는** 거꾸로 된 일이 벌어졌습니다.
    //   "입원하셨다고 따님과 통화" 처럼 잘 적은 기록이 갈래 한 줄만 받았습니다.
    //
    //   그래서 언제나 부르되, **갈래를 덮는 것은 규칙이 헷갈릴 때만** 허용합니다.
    //   비용은 서버가 호출마다 이번 달 누적을 보고 상한에서 자릅니다.
    const ruleWasConfident = r.confidence !== "low";

    setAiThinking(true);
    const { suggestion, error } = await classifyWithAi(note, checkedAt);
    setAiThinking(false);
    if (error || !suggestion) {
      // AI가 안 돼도 규칙 결과가 이미 들어가 있습니다. 조용히 넘어갑니다.
      if (error)
        setAiOut({
          situation: "",
          nextAction: "",
          watchOut: "",
          reason: "AI가 읽지 못했습니다 — 규칙이 낸 결과를 씁니다.",
          confidence: "low",
        });
      return;
    }
    const kind = suggestion.resultKind as ResultKind;
    if (!RESULT_KIND_META[kind]) return;

    // 규칙이 확신했으면 갈래는 건드리지 않고 **글만** 받습니다.
    // AI 가 다르게 봤으면 그 사실은 적어 둡니다 — 담당자가 보고 고를 수 있게.
    if (ruleWasConfident) {
      setAiOut({
        situation: suggestion.situation,
        nextAction: suggestion.nextAction,
        watchOut: suggestion.watchOut,
        reason:
          kind === r.resultKind
            ? suggestion.reason
            : `${suggestion.reason} (AI는 「${RESULT_KIND_META[kind].label}」로 보았습니다. 갈래는 규칙이 낸 「${RESULT_KIND_META[r.resultKind]?.label ?? r.resultKind}」를 그대로 두었습니다 — 다르게 보시면 아래 「직접 고치기」에서 골라주세요.)`,
        confidence: suggestion.confidence,
      });
      return;
    }

    // ★ 규칙이 「전해 들은 이야기」로 보고 막아 둔 건은 AI 가 풀지 못합니다.
    //
    // 이 방어벽은 사고에서 나왔습니다 — "요양원 가셨다는 말도 있어"를 종료로 읽어
    // 97세 독거 어르신이 다음 날부터 모든 화면에서 사라졌습니다. 그래서 규칙을 통째로
    // 다시 쓰고 회귀 테스트를 붙였습니다.
    //
    // 그런데 AI 를 얹으면서 우회로가 생겼습니다. AI 는 **규칙이 헷갈려 할 때만**
    // 불려 나오고(confidence low), 규칙이 헷갈리는 대표 사례가 바로 전언입니다.
    // 즉 방어벽이 가장 필요한 지점에서만 AI 가 일하고, 그 답이 방어벽을 덮었습니다.
    // 테스트 여섯 건이 전부 통과하는데도 같은 사고가 재현됩니다.
    //
    // 명단에서 빼는 쪽으로는 AI 가 등급을 올릴 수 없습니다. 반대 방향(남기는 쪽)은
    // 막지 않습니다 — 틀렸을 때 치르는 값이 다르기 때문입니다.
    const TERMINAL: ResultKind[] = ["사망", "요양원입소", "이사전출", "급식자격상실", "타기관이용"];
    // 조건을 넓힙니다.
    //
    // 처음에는 "규칙이 확인불가를 냈을 때"만 막았는데, 「일시적사정」과 「이용감소」는
    // 규칙상 **항상 저확신**이라 언제나 AI 를 부르고 언제나 이 가드를 비껴갔습니다.
    //
    //   "손주 보러 잠시 가셨다는 말도 있고, 그 뒤로 요양원 들어가셨다 함"
    //   → 규칙은 「일시적사정」(잠시) · 저확신 → AI 호출 → AI 가 「요양원입소」
    //   → 가드 통과 못 함 → 명단에서 영구 제외
    //
    // 규칙 단독이면 방어벽에 걸리는 문장이, **AI 를 켜면 오히려 뚫립니다.**
    // 이제 규칙이 종료 계열을 내지 않았다면 AI 혼자서는 올리지 못합니다.
    // 명단에서 빼는 일은 사람이 직접 고르게 둡니다.
    if (TERMINAL.includes(kind) && !TERMINAL.includes(r.resultKind as ResultKind)) {
      setAiOut({
        situation: suggestion.situation,
        nextAction: suggestion.nextAction,
        watchOut: suggestion.watchOut,
        reason: `AI는 「${RESULT_KIND_META[kind].label}」로 보았습니다. 명단에서 빼는 갈래라 자동으로 반영하지 않습니다 — 직접 확인하신 것이 맞으면 아래 「직접 고치기」에서 골라주세요.`,
        confidence: "low",
      });
      return; // 갈래는 규칙이 낸 확인불가를 그대로 둡니다
    }
    // 갈래는 AI 것을 쓰되, **날짜는 우리 달력이 먼저입니다.**
    //
    // 실제로 "추석으로 고향 가심"에 AI가 2026-10-07 을 내놨습니다. 그해 추석은 9/24~26
    // 입니다. 틀린 복귀일로 목록에서 빼면 그만큼 어르신을 늦게 찾습니다.
    //
    // 우리는 공휴일 표를 갖고 있습니다. 짐작이 필요 없는 것을 짐작시키지 않습니다.
    // AI 가 낸 복귀 예정일도 규칙과 **같은 그물**을 통과해야 합니다.
    // 날짜는 어르신을 목록에서 빼두는 기한이 됩니다 — 틀리면 그만큼 늦게 찾아뵙습니다.
    apply(kind, fromCtx ?? withinHalfYear(suggestion.resumeExpected, checkedAt));
    setAiOut({
      situation: suggestion.situation,
      nextAction: suggestion.nextAction,
      watchOut: suggestion.watchOut,
      reason: suggestion.reason,
      confidence: suggestion.confidence,
    });
  };

  // 분류를 확정해 기록합니다 (9-2 전이표대로 상태가 정해집니다).
  /**
   * 저장 중에는 다시 누르지 못하게 합니다.
   *
   * 「[종결] 멀리 이사 가심」이 똑같이 두 번 들어간 기록이 실제로 있었습니다. 저장은
   * 서버를 다녀오는 동안 잠깐 멈추는데, 그 사이 한 번 더 눌리면 id 가 달라 두 줄이 됩니다.
   * 확인 기록은 세어서 적중률을 내는 자료라, 중복 한 줄이 비율을 흔듭니다.
   */
  const [saving, setSaving] = useState(false);
  // state 만으로는 부족합니다. 리렌더가 끼기 전에 두 클릭이 들어오면 둘 다 false 를
  // 봅니다. 화면 잠금은 state 로, 실제 차단은 ref 로 합니다.
  const savingRef = useRef(false);

  const submitClassified = async () => {
    if (!target || !pickedKind) return;
    const meta = RESULT_KIND_META[pickedKind];
    // ★ 저장을 막지 않습니다.
    //
    //   예전에는 「일시적 사정」 갈래일 때 복귀 예정일을 안 적으면 저장을 거부했습니다.
    //   그런데 바로 아래 「다음 확인 시점」에서 이미 날짜를 고르고 계십니다 — 같은 질문을
    //   두 번 하고, 한쪽을 안 채웠다고 통화 내용까지 통째로 못 남기게 한 것입니다.
    //   실제로 "날짜를 선택하라고만 뜨고 저장이 안 된다"는 말이 나왔습니다.
    //
    //   복귀 예정일을 따로 안 적으셨으면 고르신 다음 확인 시점을 그 날로 씁니다.
    //   둘 다 "언제 다시 볼까"를 묻는 것이라 답이 하나면 충분합니다.
    const resumeDate = pickedResume || (meta.needsResumeDate ? resolveSnoozeUntil() : null);
    // 개입이 필요했는지는 결과 종류에서 따라 나옵니다 — 담당자에게 두 번 묻지 않습니다.
    const outcome: FollowupOutcome =
      pickedKind === "확인불가" ? "no_answer" : pickedKind === "위기" ? "needed" : "not_needed";
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    // ★ try/finally 로 감쌉니다.
    //
    //   예전에는 addFollowup 이 예외를 던지면(끊긴 네트워크에서 fetch 가 그렇습니다)
    //   아래 `savingRef.current = false` 에 영영 못 닿았습니다. 이 창은 대시보드에
    //   항상 붙어 있어 상태가 살아 있으므로, **그 뒤 모든 저장이 맨 위 `if
    //   (savingRef.current) return;` 에서 조용히 버려집니다.** 오류도 토스트도 없이
    //   단추만 안 먹습니다. 새로고침 전까지 그 브라우저로는 기록을 남길 수 없습니다.
    let res: Awaited<ReturnType<typeof addFollowup>>;
    try {
      res = await addFollowup({
        reaction,
        reactionNote,
        residentId: target.resident.id,
        checkedAt,
        staff,
        // ★ **가려지기 전 등급**을 남깁니다.
        //   안심 처리된 분은 assessment.level 이 normal 이라, 그 상태에서 다시 전화해
        //   기록하면 그 기록이 「정상」으로 저장됐습니다. 나중에 「그 달에 긴급이었던
        //   분」을 세는 곳(getMonthHandled)이 이 기록을 못 찾고, 통계 명단에는 초록
        //   「정상」 배지가 붙습니다 — 같은 분이 대시보드에서는 긴급인데요.
        riskLevel: target.assessment.levelBeforeSnooze ?? target.assessment.level,
        outcome,
        note: note.trim(), // ★ 원문을 그대로 남깁니다. 분류만 남기면 나중에 검증이 불가능합니다.
        // 확인불가(연락 안 됨)에는 기한을 걸지 않습니다. 사양: "확인 불가는 해제 사유가
        // 아님 — 연락이 안 되는 것 자체가 위기 신호". 목록에 그대로 두고, 몇 번째 부재중인지를
        // 화면에 적어 담당자가 판단하게 합니다.
        // 화면에서 고른 「다음 확인 시점」을 그대로 저장합니다.
        //
        // 여기가 resolveSnoozeUntil() 을 안 부르고 pickedResume 만 보고 있었습니다. 그래서
        // 「2주 뒤」를 골라 "→ 09-30까지 빠졌다가 자동 복귀"라는 안내를 읽고 눌러도
        // 기한이 null 로 저장됐습니다. 화면이 약속한 것과 저장된 것이 달랐습니다.
        snoozeUntil:
          meta.status === "종료"
            ? "2999-12-31"
            : pickedKind === "확인불가"
              ? null
              : // 복귀 예정일과 다음 확인 시점 중 **이른 날**을 씁니다.
                //   예전에는 복귀 예정일이 무조건 이겼습니다. 「내년 봄에 오신다」고 적고
                //   다음 확인은 2개월로 두면, 화면은 "2개월 뒤 자동 복귀"라고 약속해 놓고
                //   실제로는 5개월 반 동안 어느 목록에도 안 떴습니다.
                ([pickedResume, resolveSnoozeUntil()].filter(Boolean).sort()[0] ?? null),
        resultKind: pickedKind,
        resumeExpected: resumeDate,
      });
      // ★ 저장에 실패하면 **적어둔 내용을 지우지 않고 창도 닫지 않습니다.**
      //   통화 내용을 길게 적고 눌렀다가 실패하면 그 글이 복구 불가능하게 사라졌습니다.
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    if (!res.ok) return void toast.error(`저장하지 못했습니다 — ${res.error}`);
    toast.success(`${residentLabel(target.resident)}님 — ${meta.label}(으)로 기록했습니다.`);
    closeAll();
  };

  const addDaysStr = (dateStr: string, n: number) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };

  // 지금은 괜찮으심일 때 언제까지 안심할지: 날짜를 직접 골랐으면 그 날짜, 아니면 프리셋(N일).
  const resolveSnoozeUntil = (): string | null => {
    if (snoozeDate) return snoozeDate; // 복귀 예정일 직접 지정 우선
    if (snoozeDays > 0) return addDaysStr(checkedAt, snoozeDays);
    return null; // 안 고르면 기본 기한(recheckDueDate)이 정합니다
  };

  /**
   * 저장할 갈래를 정합니다.
   *
   * ★ 실제 자료를 보고 찾았습니다 — 하루치 23건이 **전부 갈래 없이** 저장돼 있었습니다.
   *
   *   갈래(result_kind)가 비면 getMemberState 가 종료·보류 경로를 아예 타지 않습니다.
   *   즉 담당자가 "8월에 사망하심" 이라고 또렷하게 적고 저장해도, 그 글은 메모로만 남고
   *   **그분은 다음 날에도 「연락할 분」에 그대로 서 있습니다.** 기록은 남았는데 반영이
   *   안 되니, 담당자는 같은 분께 또 전화를 겁니다.
   *
   *   왜 비었나 — 「직접 고치기」를 펼쳐 갈래를 고르지 않고 바로 아래 단추(지금은 괜찮으심 /
   *   도움이 더 필요 / 부재중)를 누르면 pickedKind 가 null 인 채로 저장됩니다.
   *   현장에서는 그게 자연스러운 동작입니다 — 갈래 고르는 자리는 접혀 있으니까요.
   *
   *   그래서 비어 있으면 **적어 주신 글에서 규칙으로 읽어냅니다.** 규칙은 이미 있고,
   *   화면 위쪽 「적은 내용으로 정리하기」가 쓰는 것과 같은 것입니다. 사람에게 두 번
   *   묻지 않는다는 이 창의 원칙과도 맞습니다.
   *
   *   다만 **명단에서 빼는 갈래는 규칙 혼자 정하지 않습니다.** 사망·요양원입소·이사전출·
   *   급식자격상실·타기관이용은 한 번 빠지면 자동으로 안 돌아옵니다. 그건 담당자가
   *   「적은 내용으로 정리하기」로 확인하고 누르거나 직접 고르셔야 합니다.
   */
  const TERMINAL_KINDS: ResultKind[] = [
    "사망",
    "요양원입소",
    "이사전출",
    "급식자격상실",
    "타기관이용",
  ];

  /**
   * 갈래를 안 고르셨을 때, 적으신 글이 **확신이 낮은 채로** 「명단에서 빼는 갈래」로
   * 읽히는가. 이때만 담당자께 한 번 여쭙니다.
   */
  const terminalInNote = (): ResultKind | null => {
    if (pickedKind) return null;
    const body = note.trim();
    if (!body) return null;
    const r = classifyFollowupNote(body, checkedAt);
    return TERMINAL_KINDS.includes(r.resultKind) && r.confidence !== "high" ? r.resultKind : null;
  };

  const kindToSave = (outcome: FollowupOutcome): ResultKind | null => {
    if (pickedKind) return pickedKind;
    const body = note.trim();
    if (!body) return outcome === "no_answer" ? "확인불가" : null;
    const r = classifyFollowupNote(body, checkedAt);
    // ★ 확신이 높은 종료는 **어느 단추를 누르셔도 그대로 반영합니다.**
    //
    //   처음에는 명단에서 빼는 갈래를 전부 사람이 누르게 막아 두었습니다. 그런데 화면
    //   위쪽 「적은 내용으로 정리하기」는 **이미 같은 판단으로 자동 반영하고 있습니다.**
    //   같은 글, 같은 규칙인데 어느 단추를 눌렀느냐로 결과가 갈리는 셈이었습니다.
    //   담당자에게 그 구분은 보이지 않으니, 남는 것은 "적었는데 왜 반영이 안 되냐"뿐입니다.
    //
    //   막으려던 진짜 위험은 **전해 들은 말로 사람을 지우는 것**이고, 그건 여기가 아니라
    //   규칙 안에서 이미 막습니다 — 「돌아가셨대」·「요양원 가셨다더라」는 전언으로 읽혀
    //   확신이 낮아지고 확인불가로 떨어집니다(followup-classify 의 HEARSAY).
    //
    //   그래서 확신이 낮은 종료만 사람에게 여쭙니다(아래 terminalInNote 경고).
    if (TERMINAL_KINDS.includes(r.resultKind) && r.confidence !== "high") return null;
    return r.resultKind;
  };

  const submitNew = async (outcome: FollowupOutcome) => {
    if (!target) return;
    // 지금은 괜찮으심 → 담당자가 고른 기한만큼 안심.
    // 부재중     → **목록에 그대로 둡니다.** 전화를 못 받은 것은 확인이 끝난 게 아니라
    //              아직 못 만난 것입니다. 사양: "연락이 안 되는 것 자체가 위기 신호".
    //              몇 번째인지는 화면에 적히고, 3회가 쌓이면 방문 목록으로 올라갑니다.
    // 개입 필요  → 목록에 그대로 둡니다.
    // ★ 「도움이 더 필요」에도 고른 기한을 적용합니다.
    //
    //   예전에는 not_needed 일 때만 기한을 썼습니다. 그래서 담당자가 「3개월」을 찍고
    //   바로 아래 「도움이 더 필요」를 누르면 **그 3개월이 조용히 버려졌습니다.**
    //   날짜 고르는 칸이 두 단추 바로 위에 있는데 한쪽만 먹는다는 것을 알 길이 없습니다.
    //   실제로 "3개월로 정정했는데 왜 계속 뜨냐"는 말이 나왔고, 기록을 열어 보니 기한이
    //   비어 있었습니다.
    //
    //   개입이 필요한 분께 기한을 거는 것은 이상한 일이 아닙니다 — "입원 중, 3개월 뒤
    //   퇴원 예정"이 바로 그 경우입니다. 부재중만 기한을 안 겁니다(아직 못 만났으니까).
    // 저장이 끝나면 적은 내용을 비우므로, 판단은 지금 해 둡니다.
    const terminalInNoteAtSave = terminalInNote();
    const savedKind = kindToSave(outcome);
    // 종료 갈래면 기한도 먼 미래로 둡니다 — 위쪽 「이대로 기록하기」와 같은 값입니다.
    // (getMemberState 는 갈래만 보고도 종료로 읽지만, 두 경로가 다른 값을 남기면
    //  나중에 기록을 맞춰볼 때 어느 쪽이 맞는지 알 수 없게 됩니다.)
    //   · 종료 갈래  → 먼 미래(위쪽 「이대로 기록하기」와 같은 값)
    //   · 확인불가   → 기한 없음. 연락이 안 되는 것은 해제 사유가 아니라 그 자체로
    //                 신호라, 목록에 그대로 둡니다. 실제로 「이웃 말로는 돌아가셨다고
    //                 함」을 저장했더니 두 달짜리 기한이 붙었습니다 — 판정은 다행히
    //                 갈래를 보고 그분을 목록에 남겼지만, 기록에는 앞뒤가 다른 값이
    //                 남습니다.
    //   · 그 밖      → 담당자가 고른 기한
    const snoozeUntil =
      savedKind && RESULT_KIND_META[savedKind]?.status === "종료"
        ? "2999-12-31"
        : savedKind === "확인불가" || outcome === "no_answer"
          ? null
          : resolveSnoozeUntil();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    // ★ try/finally 로 감쌉니다.
    //
    //   예전에는 addFollowup 이 예외를 던지면(끊긴 네트워크에서 fetch 가 그렇습니다)
    //   아래 `savingRef.current = false` 에 영영 못 닿았습니다. 이 창은 대시보드에
    //   항상 붙어 있어 상태가 살아 있으므로, **그 뒤 모든 저장이 맨 위 `if
    //   (savingRef.current) return;` 에서 조용히 버려집니다.** 오류도 토스트도 없이
    //   단추만 안 먹습니다. 새로고침 전까지 그 브라우저로는 기록을 남길 수 없습니다.
    let res: Awaited<ReturnType<typeof addFollowup>>;
    try {
      res = await addFollowup({
        reaction,
        reactionNote,
        residentId: target.resident.id,
        checkedAt,
        staff,
        riskLevel: target.assessment.levelBeforeSnooze ?? target.assessment.level,
        outcome,
        note: note.trim(),
        snoozeUntil,
        // ★ 위에서 고른 갈래를 함께 보냅니다.
        //
        //   예전에는 안 보냈습니다. 그래서 AI가 「일시적 사정 · 복귀 10-05」로 정리해 준 뒤
        //   기한만 손보려고 「직접 고치기」를 펼쳤다가 눈에 익은 「지금은 괜찮으심」을
        //   누르면, 방금 본 분류가 **어디에도 안 남았습니다.** getMemberState 가 보류 경로를
        //   아예 안 타서 판정도 달라졌습니다.
        resultKind: savedKind,
        resumeExpected: pickedResume || null,
      });
      // ★ 실패하면 적어둔 내용을 지우지 않습니다 (아래 setNote("") 에 닿지 않게 여기서 멈춤).
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    if (!res.ok) return void toast.error(`저장하지 못했습니다 — ${res.error}`);
    // ★ 조용히 아무 일도 안 일어나는 자리를 없앱니다.
    //
    //   "8월에 사망하심" 이라고 적고 「지금은 괜찮으심」을 누르면, 기록은 남지만
    //   그분은 내일도 「연락할 분」에 그대로 서 계십니다. 담당자 눈에는 분명히 적어
    //   넣었는데 아무 반응이 없으니 "반영이 안 된다"가 됩니다.
    //
    //   명단에서 빼는 일은 규칙이 혼자 하면 안 되지만(한 번 빠지면 자동으로 안 돌아옵니다),
    //   **말은 해야 합니다.** 무엇을 더 눌러야 하는지까지 적습니다.
    const terminal = terminalInNoteAtSave;
    if (terminal) {
      toast.warning(
        `「${RESULT_KIND_META[terminal].label}」으로 읽히는 내용입니다 — 이대로는 명단에 그대로 남습니다. 명단에서 빼시려면 아래 「사례 관리 종료」를 눌러주세요.`,
        { duration: 10000 },
      );
    }
    // ★ 안내 문구를 **실제로 일어난 일**에 맞춥니다.
    //
    //   예전에는 누른 단추(outcome)만 보고 적었습니다. 그래서 「돌아가셨다고 하심」을
    //   적고 저장하면 "확인 완료. 2999-12-31까지 위기 목록에서 빠집니다" 라고 떴고,
    //   반대로 「이웃 말로는 돌아가셨다고 함」에는 "2026-11-18까지 빠집니다" 라고
    //   떴는데 **그분은 목록에 그대로 남아 있었습니다.** 화면이 한 말과 실제가 다르면
    //   담당자는 다음부터 화면을 안 믿습니다.
    const who = residentLabel(target.resident);
    toast.success(
      savedKind && RESULT_KIND_META[savedKind]?.status === "종료"
        ? `${who}님 — ${RESULT_KIND_META[savedKind].label}(으)로 기록했습니다. 앞으로 확인 대상에서 빠집니다.`
        : savedKind === "확인불가"
          ? `${who}님 — 확인불가로 기록했습니다. 아직 확인된 것이 아니라 목록에 그대로 둡니다.`
          : outcome === "needed"
            ? `${residentLabel(target.resident)}님 — 개입 필요로 기록했습니다.`
            : outcome === "no_answer"
              ? `${residentLabel(target.resident)}님 — 부재중으로 기록했습니다. 연락이 닿을 때까지 목록에 남습니다.`
              : snoozeUntil
                ? `${residentLabel(target.resident)}님 — 확인 완료. ${snoozeUntil}까지 위기 목록에서 빠집니다.`
                : `${residentLabel(target.resident)}님 — 확인 완료(지금은 괜찮으심)로 기록했습니다.`,
    );
    setNote("");
    setSnoozeDate("");
    setReaction(null);
    setReactionNote("");
  };

  // 종결 = 사망·이사·요양원 입소·급식자격상실 등 "더 이상 급식으로 볼 수 없게 된 분".
  // 먼 미래 기한의 안심 처리로 모든 위기 목록에서 영구히 빼둡니다(확인됨 칸에 '종결'로 표시).
  const submitClose = async () => {
    if (!target) return;
    if (!note.trim()) {
      toast.error("종결 사유를 적어주세요 (예: 요양원 입소, 이사).");
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    // ★ try/finally 로 감쌉니다.
    //
    //   예전에는 addFollowup 이 예외를 던지면(끊긴 네트워크에서 fetch 가 그렇습니다)
    //   아래 `savingRef.current = false` 에 영영 못 닿았습니다. 이 창은 대시보드에
    //   항상 붙어 있어 상태가 살아 있으므로, **그 뒤 모든 저장이 맨 위 `if
    //   (savingRef.current) return;` 에서 조용히 버려집니다.** 오류도 토스트도 없이
    //   단추만 안 먹습니다. 새로고침 전까지 그 브라우저로는 기록을 남길 수 없습니다.
    let res: Awaited<ReturnType<typeof addFollowup>>;
    try {
      // ★ 종결에도 **갈래를 남깁니다.**
      //
      //   예전에는 `[종결]` 이라는 글머리만 남겼습니다. 목록에서 빼는 데는 그걸로
      //   충분했지만(getMemberState 의 closedByNote), 무엇 때문에 종결했는지가
      //   자료에 안 남습니다. 그래서 「사례 관리 종료 5명」이라고만 뜨고 그중 몇 분이
      //   돌아가셨는지, 몇 분이 이사 가셨는지는 세어볼 길이 없었습니다.
      //
      //   담당자가 이미 고르셨으면 그것을, 안 고르셨으면 적어 주신 글에서 읽습니다.
      //   여기는 종결 단추라 사람이 이미 「명단에서 뺀다」를 누른 자리이므로, 아래
      //   submitNew 와 달리 명단에서 빼는 갈래를 그대로 씁니다.
      const closeKind: ResultKind | null =
        pickedKind ??
        (note.trim() ? classifyFollowupNote(note.trim(), checkedAt).resultKind : null);
      res = await addFollowup({
        residentId: target.resident.id,
        checkedAt,
        staff,
        riskLevel: target.assessment.levelBeforeSnooze ?? target.assessment.level,
        outcome: "not_needed",
        note: `[종결] ${note.trim()}`,
        snoozeUntil: "2999-12-31",
        resultKind: closeKind === "확인불가" ? null : closeKind,
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    if (!res.ok) return void toast.error(`저장하지 못했습니다 — ${res.error}`);
    toast.success(`${residentLabel(target.resident)}님 — 종결 처리했습니다(목록에서 빠집니다).`);
    setNote("");
    setReaction(null);
    setReactionNote("");
  };

  const startEdit = (f: Followup) => {
    setEditingId(f.id);
    setEditNote(f.note);
    // 지금 걸려 있는 기한을 그대로 띄웁니다. 빈칸으로 열면 담당자가 고칠 생각이 없던
    // 기한까지 지워집니다.
    setEditSnooze(f.snoozeUntil ?? null);
    setEditReaction(f.reaction);
    setEditReactionNote(f.reactionNote);
  };

  /**
   * 종결·보류를 풀어 어르신을 목록으로 되돌립니다.
   *
   * 「기록 수정」으로는 안 됩니다 — 목록에서 빼는 것은 글자가 아니라 `snoozeUntil`
   * (종결 단추가 심는 "2999-12-31", 976년치 안심)과 `resultKind` 이기 때문입니다.
   * 그래서 화면은 "고치면 돌아옵니다"라고 안내하는데 실제로는 영영 안 돌아왔습니다.
   *
   * 기록 자체는 **지우지 않습니다.** 종결했던 사실도 기록이고, 누가 언제 왜 그랬는지는
   * 남아야 합니다. 되돌린 것도 함께 적어 둡니다.
   */
  const undoExclusion = async (f: Followup) => {
    if (
      !window.confirm(
        `${f.checkedAt} 기록의 제외를 풀고 목록으로 되돌릴까요?

기록은 지워지지 않습니다. 「${
          f.resultKind ? (RESULT_KIND_META[f.resultKind]?.label ?? f.resultKind) : "종결"
        }」 처리만 해제됩니다.`,
      )
    )
      return;
    const cleaned = f.note.replace(/^\[종결\]\s*/, "").trim();
    const res = await updateFollowup(f.id, {
      // ⚠️ outcome 은 **그대로 둡니다.**
      //
      //   처음에 `no_answer` 로 바꿔 썼는데, 종결 기록의 원래 값은 `not_needed`
      //   입니다(통화해서 확인했다는 뜻). 되돌리면서 그걸 「전화를 못 받았다」로
      //   고쳐 쓰면 없던 부재중이 생기고, unreachableStreak 이 3에 닿으면
      //   「🚪 방문 확인이 필요합니다」에 올라갑니다 — 통화가 됐던 분 댁으로
      //   방문을 나가게 됩니다. 도움 필요 비율 통계도 흔들립니다.
      //
      //   목록 복귀는 아래 snoozeUntil·resultKind 를 비우는 것이 이미 합니다.
      //   확인 결과라는 **사실**은 고칠 이유가 없습니다.
      outcome: f.outcome,
      // 되돌렸다는 사실을 기록에 남깁니다. 나중에 "왜 다시 떴지?"에 답이 됩니다.
      // ★ 직원 실명을 어르신 기록 본문에 적지 않습니다.
      //
      //   예전에는 「(○○○가 제외를 해제함)」처럼 남았습니다. 어르신 이름은 저장
      //   단계에서 가리면서 직원 이름은 그대로 본문에 박아 넣고 있었고, 그 본문은
      //   연계 의뢰서로 인쇄되어 외부 기관에 나갑니다. 게다가 조사도 틀렸습니다
      //   (「○○○가」 → 「○○○이」). 누가 풀었는지는 이미 staff 칸에 남습니다.
      note: `${cleaned}${cleaned ? " " : ""}(목록으로 되돌림)`,
      staff: editStaff,
      snoozeUntil: null,
      resultKind: null,
      resumeExpected: null,
    });
    if (!res.ok) return void toast.error(`되돌리지 못했습니다 — ${res.error}`);
    toast.success("목록으로 되돌렸습니다. 다음 판정부터 다시 올라옵니다.");
  };

  const saveEdit = async (f: Followup, outcome: FollowupOutcome) => {
    // 서버가 답한 뒤에 알립니다. 예전에는 부르자마자 초록 토스트를 띄워서, 저장이
    // 거부돼도 담당자는 고쳐진 줄 알았습니다(뒤늦게 빨간 토스트가 뜨고 화면은 되돌아갑니다).
    const res = await updateFollowup(f.id, {
      outcome,
      note: editNote.trim(),
      staff: editStaff,
      // 키를 넘겨야 서버까지 갑니다(안 넘기면 "그대로 두라"는 뜻입니다).
      snoozeUntil: editSnooze,
      reaction: editReaction,
      reactionNote: editReactionNote,
    });
    if (!res.ok) return void toast.error(`수정하지 못했습니다 — ${res.error}`);
    toast.success("확인 기록을 수정했습니다.");
    setEditingId(null);
    setEditSnooze(null);
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && closeAll()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {target ? residentLabel(target.resident) : ""}님 확인 기록
            {/* 확인 기록 창에서도 목록과 같은 등급을 보여야 합니다 — 담당자가
                「긴급」이라 적힌 줄을 눌렀는데 창 제목이 「정상」이면 손이 멈춥니다. */}
            {target && (
              <RiskBadge level={target.assessment.levelBeforeSnooze ?? target.assessment.level} />
            )}
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          지금까지 <b className="font-medium text-foreground">{history.length}회</b> 확인했습니다.
          {history.length > 0 && " 이전 기록을 확인한 뒤 새 내용을 적어주세요."}
        </p>

        {canRecord && (
          <div className="rounded-md border bg-stone-50/70 p-3">
            {/* 두 날짜는 다른 것을 뜻합니다.
                「자료 기준일」은 판정이 서 있는 날짜(엔컴 자료가 들어온 마지막 날)이고,
                「오늘」은 담당자가 실제로 전화하고 적는 날입니다. 하나만 보여주니 오늘
                적은 기록이 어제 것으로 보였습니다. */}
            <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-semibold">{history.length + 1}차 확인 기록</span>
              <span className="text-muted-foreground">
                오늘 <b className="font-semibold text-foreground">{checkedAt}</b> 입력 · 자료 기준일{" "}
                <span className="tabular-nums">{dataAsOf}</span>
              </span>
            </div>
            {/* ★ 지난 달을 보며 적을 때는 **어디에 남는지 말해 줍니다.**
                담당자는 8월 명단을 띄워 놓고 전화를 돌립니다. 기록이 오늘 날짜로 들어가면
                8월 화면으로 돌아갔을 때 방금 적은 것이 없어서, 같은 분께 또 겁니다.
                이제 그 달로 들어가는데, 그 사실을 모르고 적으면 그것대로 혼란스럽습니다. */}
            {checkedAt < dataAsOf && (
              <div className="mb-2.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-900">
                지난 달({checkedAt.slice(0, 7).replace("-", "년 ")}월) 명단을 보고 계셔서, 이 기록은{" "}
                <b>{checkedAt} 확인</b>으로 남습니다. 그 달 화면에서 바로 보입니다. 실제 입력 일시는
                따로 저장됩니다.
              </div>
            )}
            {/* 확인한 사람은 **로그인한 본인**입니다. 예전에는 드롭다운에서 골라야 했는데,
                첫 번째 사람이 기본값이라 바쁘면 남의 이름으로 기록이 남았습니다. */}
            <div className="rounded-md border bg-stone-50 px-3 py-2 text-xs">
              <span className="text-muted-foreground">확인한 직원</span>{" "}
              <b className="font-semibold text-foreground">{staff || "(이름 없음)"}</b>
              <span className="ml-1 text-muted-foreground">· 로그인한 계정으로 기록됩니다</span>
            </div>
            <Label className="mb-1.5 mt-3 block text-xs">
              확인 내용 · 개입이 필요/불필요한 이유
            </Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="예: 전화 연결됨. 딸 집에 다녀오셨다고 함. 건강 이상 없어 추가 지원은 필요 없어 보임."
              className="min-h-20"
            />

            {/* ★ 어르신 쪽 반응.
                「도움 필요 비율」은 담당자가 판단한 값입니다. 어르신께 이 전화가 어떻게
                닿았는지는 아무 데도 안 남았습니다. 그런데 현장에서 가장 자주 나오는
                이야기가 그것입니다 — "걱정해 줘서 고맙다고 하시더라".
                **안 고르는 것이 기본입니다.** 필수로 만들면 아무거나 눌러 두게 되고,
                그러면 한 해 치를 모아도 아무 뜻이 없습니다. */}
            <div className="mt-3 rounded-md border bg-white px-3 py-2.5">
              <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs font-semibold">어르신 반응</span>
                <span className="text-[11px] text-muted-foreground">
                  기억나시면 눌러주세요 · 안 고르셔도 됩니다
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {(["positive", "negative"] as const).map((k) => {
                  const on = reaction === k;
                  const good = k === "positive";
                  return (
                    <button
                      key={k}
                      type="button"
                      title={REACTION_META[k].hint}
                      onClick={() => {
                        // 단추를 끄면 메모도 함께 지웁니다. 안 지우면 입력칸이 숨겨진 채
                        // 값만 남아, 화면에 영영 안 보이는 기록이 저장됐습니다.
                        const next = on ? null : k;
                        setReaction(next);
                        if (!next) setReactionNote("");
                      }}
                      // 손이 닿는 느낌을 줍니다 — 살짝 떠오르고(-translate-y), 그림자가
                      // 지고, 테두리가 진해집니다. 누르는 순간에는 도로 내려앉습니다
                      // (active:translate-y-0). 전화기를 든 채 한 손으로 쓰는 화면이라
                      // "눌렀나 안 눌렀나"가 손끝으로 와야 합니다.
                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition-all duration-150 active:translate-y-0 active:shadow-none ${
                        on
                          ? good
                            ? "border-emerald-600 bg-emerald-600 text-white shadow-sm hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-md"
                            : "border-amber-600 bg-amber-600 text-white shadow-sm hover:-translate-y-0.5 hover:bg-amber-700 hover:shadow-md"
                          : good
                            ? "border-emerald-300 bg-white text-emerald-800 hover:-translate-y-0.5 hover:border-emerald-500 hover:bg-emerald-50 hover:shadow-md"
                            : "border-amber-300 bg-white text-amber-800 hover:-translate-y-0.5 hover:border-amber-500 hover:bg-amber-50 hover:shadow-md"
                      }`}
                    >
                      {REACTION_META[k].emoji} {REACTION_META[k].label}
                    </button>
                  );
                })}
                {reaction && (
                  <button
                    type="button"
                    onClick={() => {
                      setReaction(null);
                      setReactionNote("");
                    }}
                    className="text-[11px] text-muted-foreground underline"
                  >
                    지우기
                  </button>
                )}
                {/* 단추 오른쪽에 한 줄 칸. 단추가 「어느 쪽인가」라면 여기는 「왜 그러셨나」입니다.
                    "불편해하심"이 전화가 귀찮으셨던 것인지 감시받는 기분이셨던 것인지는
                    우리가 할 일이 완전히 다른데, 단추 하나로는 갈라지지 않습니다.
                    반응을 고르셨을 때만 나옵니다 — 안 고르셨으면 적을 것도 없습니다. */}
                {reaction && (
                  <input
                    type="text"
                    value={reactionNote}
                    onChange={(e) => setReactionNote(e.target.value.slice(0, 200))}
                    maxLength={200}
                    placeholder={
                      reaction === "positive"
                        ? "예: 전화 줘서 고맙다고, 다음 주엔 나오시겠다고 하심"
                        : "예: 감시받는 것 같다고 하심"
                    }
                    className="min-w-0 flex-1 basis-56 rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs transition-colors placeholder:text-stone-400 hover:border-stone-400 focus:border-stone-500 focus:outline-none"
                  />
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                한 해 치를 모아 우리 연락이 어르신께 어떻게 닿았는지 봅니다.
              </p>
            </div>

            {/* 담당자가 할 일은 글을 쓰는 것 하나입니다. 버튼 하나로 정리합니다. */}
            <Button
              type="button"
              className="mt-2.5 w-full"
              variant={pickedKind ? "outline" : "default"}
              onClick={() => void runClassify()}
              disabled={aiThinking || !note.trim()}
            >
              {aiThinking ? "AI가 읽는 중…" : pickedKind ? "다시 읽기" : "적은 내용으로 정리하기"}
            </Button>

            {/* ── AI가 정리한 결과 ─────────────────────────────────
                담당자가 할 일은 **글을 쓰는 것 하나**입니다. 갈래를 고르고, 며칠 안심할지
                정하고, 복귀일을 찍는 것은 전부 글 안에 이미 들어 있는 내용입니다. 사람에게
                두 번 묻지 않습니다.

                아래 「직접 고치기」를 펼치면 예전처럼 하나하나 고를 수 있습니다 — 자동이
                틀렸을 때 손으로 바로잡을 길이 없으면 아무도 자동을 못 믿습니다. */}
            {pickedKind && (
              <div className="mt-3 rounded-lg border-2 border-primary/40 bg-primary/[0.05] p-3.5">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-bold text-primary-foreground">
                    {RESULT_KIND_META[pickedKind].label}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {aiOut ? "AI가 읽고 정리했습니다" : "적으신 내용에서 읽었습니다"}
                  </span>
                </div>

                {/* 이렇게 하면 무슨 일이 일어나는지 — 담당자가 가장 알고 싶은 것입니다. */}
                <ul className="space-y-1 text-[13px] leading-relaxed text-foreground">
                  <li>
                    <b className="text-primary">·</b> {RESULT_KIND_META[pickedKind].hint}
                  </li>
                  <li>
                    <b className="text-primary">·</b>{" "}
                    {RESULT_KIND_META[pickedKind].status === "종료" ? (
                      <>
                        오늘부터 <b>명단에서 빠집니다.</b> 자동으로 돌아오지 않습니다
                      </>
                    ) : pickedResume ? (
                      <>
                        <b>{pickedResume}</b>까지 위기 목록에서 빼둡니다. 그날이 지나도 안 나오시면{" "}
                        <b>자동으로 다시 뜹니다</b>
                      </>
                    ) : snoozeDays > 0 ? (
                      <>
                        <b>{addDaysStr(checkedAt, snoozeDays)}</b>까지({snoozeDays}일) 위기 목록에서
                        빼둡니다. 그 뒤 자동으로 다시 뜹니다
                      </>
                    ) : (
                      <>위기 목록에 그대로 둡니다</>
                    )}
                  </li>
                </ul>

                {/* ── AI가 정리해 준 것 ────────────────────────────
                    갈래만 찍어주면 담당자에게 도움이 안 됩니다. 통화를 막 끝내고 급하게
                    적은 몇 줄을 "무슨 일이 있었는지 → 다음에 무엇을 할지 → 놓치기 쉬운
                    것"으로 풀어 줍니다. 근거(왜 그 갈래로 봤는지)도 함께 적습니다 —
                    근거 없이 칸만 채워지면 맞는지 틀린지 판단할 수 없습니다. */}
                {aiOut && (aiOut.situation || aiOut.nextAction || aiOut.reason) && (
                  <div className="mt-2.5 space-y-2 border-t border-primary/20 pt-2.5">
                    {aiOut.situation && (
                      <div>
                        <div className="text-[10px] font-bold tracking-wide text-muted-foreground">
                          정리하면
                        </div>
                        <p className="mt-0.5 text-[12.5px] leading-relaxed text-foreground">
                          {aiOut.situation}
                        </p>
                      </div>
                    )}
                    {aiOut.nextAction && (
                      <div className="rounded-md border border-emerald-200 bg-emerald-50/70 px-2.5 py-2">
                        <div className="text-[10px] font-bold tracking-wide text-emerald-800">
                          다음에 하실 일
                        </div>
                        <p className="mt-0.5 text-[12.5px] leading-relaxed text-emerald-950">
                          {aiOut.nextAction}
                        </p>
                      </div>
                    )}
                    {aiOut.watchOut && (
                      <div className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2">
                        <div className="text-[10px] font-bold tracking-wide text-amber-800">
                          놓치기 쉬운 점
                        </div>
                        <p className="mt-0.5 text-[12.5px] leading-relaxed text-amber-950">
                          {aiOut.watchOut}
                        </p>
                      </div>
                    )}
                    {aiOut.reason && (
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        이 갈래로 본 까닭 — {aiOut.reason}
                      </p>
                    )}
                  </div>
                )}

                {/* ★ 「자신 없음」은 **AI 를 불렀을 때도** 보여야 합니다.
                    예전 조건은 `!aiOut` 이라, AI 를 켜면 규칙의 저확신 안내가 **사라졌습니다.**
                    게다가 AI 가 스스로 낸 confidence 는 아무 데서도 안 썼습니다. 그래서
                    담당자는 「AI가 읽고 정리했습니다」만 보고, 자신 없다는 제안을 확신 있는
                    제안과 구분할 수 없었습니다 — AI 를 켤수록 더 못 미더워지는 구조입니다. */}
                {(aiOut?.confidence === "low" || (!aiOut && preview?.confidence === "low")) && (
                  <p className="mt-2 flex items-start gap-1.5 border-t border-amber-300 pt-2 text-[11px] leading-relaxed text-amber-900">
                    <span className="shrink-0 font-bold">⚠️ 확실하지 않습니다</span>
                    <span>
                      {aiOut?.confidence === "low"
                        ? `${aiOut.reason || "적으신 내용만으로는 갈래를 확정하기 어렵습니다"} — 아래 「직접 고치기」에서 확인해 주세요.`
                        : preview?.reason}
                    </span>
                  </p>
                )}

                {/* 날짜는 우리 달력에서 가져온 것입니다(추석이 며칠까지인지 등). */}
                {context.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {context.map((c) => (
                      <li
                        key={c.label + c.detail}
                        className="rounded-full border border-sky-300 bg-white px-2 py-0.5 text-[10px] text-sky-800"
                      >
                        {c.label} · {c.detail}
                      </li>
                    ))}
                  </ul>
                )}

                {/* ★ **언제나** 보여줍니다.
                    예전에는 `maskNames(note) !== note` 조건이 붙어 있었습니다. 그러면
                    **가릴 것을 하나도 못 잡았을 때 침묵합니다** — 원문이 통째로 나가는
                    바로 그 경우에요. 가장 필요한 순간에 꺼지는 안전장치였습니다.
                    보내기 전에 보여주므로 담당자가 이름이 남았으면 고치고 누를 수 있습니다. */}
                {note.trim() && (
                  <p className="mt-1.5 rounded border border-stone-200 bg-stone-50 px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">AI에 보낼 내용</span> ·
                    실명·전화·주소는 가려서 보냅니다. 가리기가 완전하지 않으니 아래에 이름이 남아
                    있으면 위 칸에서 고쳐 주세요.
                    <br />
                    <span className="text-foreground/80">{maskNames(note)}</span>
                  </p>
                )}

                <Button
                  type="button"
                  className="mt-3 w-full"
                  disabled={saving}
                  onClick={submitClassified}
                >
                  이대로 기록하기
                </Button>
              </div>
            )}

            {/* ── 직접 고치기 ───────────────────────────────────
                자동이 틀렸을 때 손으로 바로잡을 길이 없으면 아무도 자동을 못 믿습니다.
                그래서 예전 화면을 지우지 않고 접어 둡니다 — 평소엔 안 보이고, 필요할 때만
                펼칩니다. */}
            <details className="mt-3">
              <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground hover:text-foreground">
                직접 고치기 · 확인 결과와 재확인 일정을 손으로 정하기 ▾
              </summary>
              <div className="mt-2 space-y-3">
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {(Object.keys(RESULT_KIND_META) as ResultKind[]).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => {
                        setPickedKind(kind);
                        if (!RESULT_KIND_META[kind].needsResumeDate) setPickedResume("");
                        const d = suggestSnoozeDays(kind);
                        if (d > 0) {
                          setSnoozeDays(d);
                          setSnoozeDate("");
                        }
                      }}
                      className={`rounded-md border px-2.5 py-1.5 text-left text-xs transition ${
                        pickedKind === kind
                          ? "border-primary bg-primary/10 font-semibold text-foreground"
                          : "border-stone-200 bg-white text-muted-foreground hover:bg-stone-50"
                      }`}
                    >
                      {RESULT_KIND_META[kind].label}
                    </button>
                  ))}
                </div>
                {pickedKind && RESULT_KIND_META[pickedKind].needsResumeDate && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-medium text-foreground">
                      언제쯤 나오실까요?{" "}
                      <span className="font-normal text-muted-foreground">
                        (선택 — 안 적으면 아래 「다음 확인 시점」을 씁니다)
                      </span>
                    </span>
                    {/* min 을 겁니다. 과거 날짜를 찍으면 저장하는 순간 기한이 이미 지난
                        상태가 되어, 그분이 양쪽 목록 어디에도 안 보이게 됩니다. */}
                    <input
                      type="date"
                      value={pickedResume}
                      min={checkedAt}
                      onChange={(e) => setPickedResume(e.target.value)}
                      className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                    />
                  </div>
                )}

                <div className="mt-3 rounded-md border border-emerald-100 bg-emerald-50/50 p-2.5">
                  <Label className="mb-1.5 block text-xs text-emerald-900">
                    다음 확인 시점 (사유를 확인했으니 그때까지 목록에서 빠집니다)
                  </Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* 기간을 넓혔습니다. 현장에서 "농사철 지나고", "겨울 나고" 처럼
                        계절 단위로 쉬시는 분이 있어 1~2주로는 매번 다시 떴습니다. */}
                    {/* 2개월 단위. 1년도 「12개월」로 적습니다 — 한 줄 안에서 개월과 해가
                        섞이면 12개월과 1년 중 어느 쪽이 긴지 한 번 더 생각하게 됩니다.
                        날짜는 한 달을 30.4일로 잡아 개월 수를 곱합니다. */}
                    {[2, 4, 6, 8, 10, 12]
                      .map((m) => ({
                        label: `${m}개월`,
                        days: Math.round(m * 30.44),
                      }))
                      .map((opt) => (
                        <button
                          key={opt.days}
                          type="button"
                          onClick={() => {
                            setSnoozeDays(opt.days);
                            setSnoozeDate(""); // 프리셋을 고르면 직접 지정 날짜는 해제
                          }}
                          className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                            !snoozeDate && snoozeDays === opt.days
                              ? "border-emerald-600 bg-emerald-600 text-white"
                              : "border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                  </div>
                  {/* 복귀 예정일을 직접 아는 경우(예: "10월 5일에 온다") 날짜로 지정.
                      프리셋보다 이쪽이 정확하니 눈에 띄게 둡니다 — 담당자가 통화에서
                      날짜를 들었으면 그 날짜가 어떤 어림수보다 낫습니다. */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-md border border-emerald-300 bg-white px-2.5 py-2">
                    <span className="text-[11px] font-semibold text-emerald-900">
                      날짜를 들으셨으면 직접 지정 ▸
                    </span>
                    <input
                      type="date"
                      value={snoozeDate}
                      min={checkedAt}
                      onChange={(e) => setSnoozeDate(e.target.value)}
                      className={`rounded-md border px-2 py-1 text-xs ${
                        snoozeDate
                          ? "border-emerald-600 text-emerald-800"
                          : "border-emerald-300 text-stone-600"
                      }`}
                    />
                    {snoozeDate && (
                      <button
                        type="button"
                        onClick={() => setSnoozeDate("")}
                        className="text-[11px] text-emerald-800/70 underline"
                      >
                        지우기
                      </button>
                    )}
                  </div>
                  {/* ★ 긴 기간은 사실상 종결입니다. 막지는 않되 무슨 뜻인지 적습니다.
                      1년을 고르면 그 어르신은 1년간 어떤 목록에도 안 뜹니다. */}
                  {!snoozeDate && snoozeDays >= 91 && (
                    <div className="mt-2 rounded-md border border-amber-400 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-900">
                      <b>
                        {snoozeDays}일({Math.round(snoozeDays / 30)}개월) 동안 목록에서 빠집니다.
                      </b>{" "}
                      그 사이에는 급식에 안 나오셔도 아무 신호를 드리지 않습니다. 사정을 확실히 아실
                      때만 쓰시고, 아니면 짧게 잡고 그때 다시 보시는 편이 안전합니다.
                    </div>
                  )}
                  <p className="mt-1.5 text-[11px] text-emerald-800/70">
                    {snoozeDate
                      ? `→ ${snoozeDate}까지 빠졌다가, 그날 이후에도 안 나오시면 자동으로 다시 뜹니다`
                      : snoozeDays > 0
                        ? `→ ${addDaysStr(checkedAt, snoozeDays)}까지 빠졌다가 자동 복귀`
                        : "→ 기한을 고르지 않으면 기본 기한으로 들어갑니다(개입 필요 7일 · 확인 완료 14일)"}
                  </p>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    disabled={saving}
                    onClick={() => submitNew("not_needed")}
                  >
                    지금은 괜찮으심{" "}
                    {snoozeDate
                      ? `· ${snoozeDate.slice(5)}까지`
                      : snoozeDays > 0
                        ? `· ${snoozeDays}일 안심`
                        : ""}
                  </Button>
                  <Button className="flex-1" disabled={saving} onClick={() => submitNew("needed")}>
                    도움이 더 필요
                  </Button>
                </div>
                {/* 부재중 — 전화를 못 받으신 것. 위 둘과 나란히 두지 않고 한 줄 아래에 둡니다.
                "확인을 마친 결과"가 아니라 "아직 못 만났다"이기 때문입니다(도움 필요 비율 분모에서도
                빠집니다). 기한은 고르게 하지 않습니다 — 짧게 내려두었다 곧 다시 올라와야 합니다. */}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => submitNew("no_answer")}
                  className="mt-2 w-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100"
                >
                  부재중 · 전화를 안 받으심 — 목록에 그대로 둡니다
                </button>
                {/* 종결 — 급식으로 더 볼 수 없게 된 분(사망·이사·요양원·급식자격상실). 앞으로 확인 대상에서 제외. */}
                <button
                  type="button"
                  disabled={saving}
                  onClick={submitClose}
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
                >
                  사례 관리 종료 (사망·이사·요양원 등 — 사유를 적고 확인 대상에서 제외)
                </button>
              </div>
            </details>
          </div>
        )}

        <div>
          <div className="mb-2 text-xs font-semibold">지난 확인 기록</div>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">아직 확인 기록이 없습니다.</p>
          ) : (
            <ol className="space-y-2">
              {history.map((f, i) => {
                const ordinal = history.length - i; // 최신이 위이므로 뒤에서부터 세어 n차를 매깁니다
                const needed = f.outcome === "needed";
                if (editingId === f.id) {
                  return (
                    <li key={f.id} className="rounded-md border border-primary/40 p-3">
                      <div className="mb-2 text-xs font-semibold">
                        {ordinal}차 ({f.checkedAt}) 수정
                      </div>
                      {/* 고친 사람도 로그인한 본인으로 남습니다 — 누가 고쳤는지가 기록입니다. */}
                      <div className="rounded-md border bg-stone-50 px-3 py-2 text-xs">
                        <span className="text-muted-foreground">수정한 직원</span>{" "}
                        <b className="font-semibold text-foreground">
                          {editStaff || "(이름 없음)"}
                        </b>
                      </div>
                      <Label className="mb-1.5 mt-3 block text-xs">확인 내용 · 사유</Label>
                      <Textarea
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        className="min-h-16"
                      />
                      {/* ★ 「다음 확인 시점」이 수정 화면에 **없었습니다.**
                          담당자가 "3개월 뒤에 보기로 했다"고 고쳐도 저장되는 것은 글과
                          필요/불필요뿐이라, 그분은 기본 기한대로 며칠 만에 다시 올라왔습니다.
                          담당자는 분명히 3개월로 바꿨는데요. 고칠 수 있게 붙입니다. */}
                      {/* ★ 반응을 고칠 길이 아예 없었습니다.
                          잘못 누른 「불편해하심」은 기록을 **삭제하는 것 말고는** 되돌릴
                          방법이 없었습니다. 한 해 치를 모아 쓰는 값이라 한 건이 틀리면
                          그만큼 비율이 틀어집니다. */}
                      <Label className="mb-1.5 mt-3 block text-xs">어르신 반응</Label>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(["positive", "negative"] as const).map((k) => {
                          const on = editReaction === k;
                          const good = k === "positive";
                          return (
                            <button
                              key={k}
                              type="button"
                              onClick={() => {
                                const next = on ? null : k;
                                setEditReaction(next);
                                if (!next) setEditReactionNote("");
                              }}
                              className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                                on
                                  ? good
                                    ? "border-emerald-600 bg-emerald-600 text-white"
                                    : "border-amber-600 bg-amber-600 text-white"
                                  : good
                                    ? "border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-50"
                                    : "border-amber-300 bg-white text-amber-800 hover:bg-amber-50"
                              }`}
                            >
                              {REACTION_META[k].emoji} {REACTION_META[k].label}
                            </button>
                          );
                        })}
                        {editReaction && (
                          <input
                            type="text"
                            value={editReactionNote}
                            onChange={(e) => setEditReactionNote(e.target.value.slice(0, 200))}
                            maxLength={200}
                            placeholder="어떤 반응이셨는지 한 줄"
                            className="min-w-0 flex-1 basis-48 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                          />
                        )}
                      </div>

                      <Label className="mb-1.5 mt-3 block text-xs">다음 확인 시점</Label>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {[2, 4, 6, 8, 10, 12]
                          .map((m) => ({ label: `${m}개월`, days: Math.round(m * 30.44) }))
                          .map((opt) => (
                            <button
                              key={opt.days}
                              type="button"
                              onClick={() => setEditSnooze(addDaysStr(checkedAt, opt.days))}
                              className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                                editSnooze === addDaysStr(checkedAt, opt.days)
                                  ? "border-emerald-600 bg-emerald-600 text-white"
                                  : "border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100"
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        <input
                          type="date"
                          value={editSnooze ?? ""}
                          min={checkedAt}
                          onChange={(e) => setEditSnooze(e.target.value || null)}
                          className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                        />
                        {editSnooze && (
                          <button
                            type="button"
                            onClick={() => setEditSnooze(null)}
                            className="text-[11px] text-muted-foreground underline"
                          >
                            지우기
                          </button>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {editSnooze
                          ? `→ ${editSnooze}까지 목록에서 빠졌다가 자동으로 다시 뜹니다`
                          : "→ 비워두면 기본 기한(개입 필요 7일 · 확인 완료 14일)으로 돌아옵니다"}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1"
                          onClick={() => saveEdit(f, "not_needed")}
                        >
                          불필요로 저장
                        </Button>
                        <Button size="sm" className="flex-1" onClick={() => saveEdit(f, "needed")}>
                          필요로 저장
                        </Button>
                        {/* ★ 부재중 기록을 고칠 길이 없었습니다.
                            단추가 「불필요」와 「필요」 둘뿐이라, 메모 오타 하나 고치려고
                            수정을 열면 반드시 둘 중 하나로 **뒤집혔습니다.** 전화를 안
                            받으신 분이 「확인 완료」가 되어 2주간 목록에서 사라지고,
                            부재중 연속 횟수가 끊겨 「🚪 방문 확인」에도 영영 못 올라갔습니다.
                            원래 부재중이던 기록에만 이 단추를 보여줍니다. */}
                        {f.outcome === "no_answer" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1 border-amber-400 text-amber-900 hover:bg-amber-50"
                            onClick={() => saveEdit(f, "no_answer")}
                          >
                            부재중으로 저장
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          취소
                        </Button>
                      </div>
                    </li>
                  );
                }
                return (
                  <li key={f.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-foreground">{ordinal}차</span>
                        <span className="tabular-nums text-muted-foreground">{f.checkedAt}</span>
                        <span className="text-muted-foreground">{f.staff}</span>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                            needed
                              ? "border-red-200 bg-red-50 text-red-700"
                              : f.outcome === "no_answer"
                                ? "border-amber-200 bg-amber-50 text-amber-800"
                                : "border-emerald-200 bg-emerald-50 text-emerald-700"
                          }`}
                        >
                          {needed
                            ? "도움이 더 필요"
                            : f.outcome === "no_answer"
                              ? "부재중"
                              : "지금은 괜찮으심"}
                        </span>
                        {/* ★ 그때 무엇을 골랐는지를 줄에 적습니다.
                            예전에는 필요/불필요만 보였습니다. 「3개월」을 골랐는지, 갈래를
                            무엇으로 잡았는지, 어르신이 어떻게 받아들이셨는지가 안 보여서,
                            담당자가 자기가 찍은 것이 들어갔는지 확인할 방법이 없었습니다.
                            실제로 3개월이 버려진 것을 아무도 몰랐습니다. */}
                        {f.resultKind && (
                          <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800">
                            {RESULT_KIND_META[f.resultKind]?.label ?? f.resultKind}
                          </span>
                        )}
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                            f.snoozeUntil
                              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                              : "border-stone-200 bg-stone-50 text-stone-500"
                          }`}
                          title="다음 확인 시점 — 이 날까지 목록에서 빠집니다"
                        >
                          {f.snoozeUntil
                            ? f.snoozeUntil === "2999-12-31"
                              ? "종결 · 다시 안 뜸"
                              : `다음 확인 ${f.snoozeUntil}`
                            : "다음 확인일 없음"}
                        </span>
                        {f.resumeExpected && (
                          <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-800">
                            복귀 예정 {f.resumeExpected}
                          </span>
                        )}
                        {f.reaction && (
                          <span className="text-[11px] text-muted-foreground">
                            {REACTION_META[f.reaction].emoji} {REACTION_META[f.reaction].label}
                            {f.reactionNote ? ` · ${f.reactionNote}` : ""}
                          </span>
                        )}
                      </div>
                      {canRecord && (
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => startEdit(f)}
                          >
                            <Pencil className="mr-1 h-3 w-3" />
                            수정
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `${ordinal}차 확인 기록(${f.checkedAt})을 삭제할까요? 되돌릴 수 없습니다.`,
                                )
                              ) {
                                void deleteFollowup(f.id).then((res) =>
                                  res.ok
                                    ? toast.success("확인 기록을 삭제했습니다.")
                                    : toast.error(`삭제하지 못했습니다 — ${res.error}`),
                                );
                              }
                            }}
                          >
                            <Trash2 className="mr-1 h-3 w-3" />
                            삭제
                          </Button>
                        </div>
                      )}
                    </div>
                    {/* 이 기록 때문에 어르신이 목록에서 빠져 있다면, 푸는 길을 같은
                        자리에 둡니다. 「수정」으로는 안 풀립니다(글자만 바뀝니다). */}
                    {canRecord && (isClosedFollowup(f) || isPausedFollowup(f)) && (
                      <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-1.5">
                        <span className="text-[11px] leading-snug text-amber-900">
                          이 기록으로 <b>목록에서 빠져 있습니다.</b> 잘못 눌렀거나 다시 나오시면
                          되돌리세요.
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 shrink-0 border-amber-300 px-2 text-[11px] text-amber-900 hover:bg-amber-100"
                          onClick={() => undoExclusion(f)}
                        >
                          <RotateCcw className="mr-1 h-3 w-3" />
                          목록으로 되돌리기
                        </Button>
                      </div>
                    )}
                    <p className="mt-2 text-xs leading-relaxed text-foreground">
                      {f.note || (
                        <span className="text-muted-foreground">사유가 기록되지 않았습니다.</span>
                      )}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// 최근 확인 결과를 배지로 보여주고, 누르면 전체 이력이 열립니다. 배지는 로그인 없이도 누를 수
// 있게 둡니다(조회는 공개) — 기록·수정 버튼만 로그인 상태에서 나타납니다.
export function FollowupControl({
  followup,
  count,
  canRecord,
  onOpen,
}: {
  followup: Followup | null;
  count: number;
  canRecord: boolean;
  onOpen: () => void;
}) {
  if (followup) {
    const needed = followup.outcome === "needed";
    const noAnswer = followup.outcome === "no_answer";
    return (
      <button
        type="button"
        onClick={onOpen}
        title="개입 이력 보기"
        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium hover:brightness-95 ${
          needed
            ? "border-red-200 bg-red-50 text-red-700"
            : noAnswer
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
        }`}
      >
        <CircleCheck className="h-3 w-3" />
        {followup.checkedAt.slice(5)} {needed ? "개입" : noAnswer ? "부재중" : "확인"}
        {count > 1 && ` · ${count}회`}
      </button>
    );
  }
  if (!canRecord) return null;
  return (
    <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={onOpen}>
      <Check className="mr-1 h-3 w-3" />
      확인 기록
    </Button>
  );
}
