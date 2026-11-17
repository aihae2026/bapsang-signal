// AI 판단 Edge Function — 위기 어르신에게 "왜 위험한지 한 문장"을 붙입니다.
//
// 왜 서버(Edge Function)인가:
//  · Anthropic API 키를 화면(브라우저)에 두면 누구나 꺼내 마음대로 쓸 수 있습니다.
//    키는 여기, 서버 비밀(ANTHROPIC_API_KEY)로만 둡니다.
//  · 비용 상한을 화면에서 강제하면 우회할 수 있습니다. 상한 확인도 여기서 합니다.
//
// 정확도 원칙: **1인 1호출**. 한 번에 한 분씩만 분석합니다. 여러 명을 묶으면 모델이 답을
// 섞어 부정확해집니다. 그래서 이 함수는 항상 어르신 "한 명"의 요약만 받아 처리합니다.
//
// 개인정보: 실명·회원번호를 받지 않습니다. 호출하는 화면이 maskNames() 로 실명·전화번호·
// 주소·회원번호를 가린 요약을 보냅니다. 담당자가 적은 확인 기록 내용은 그렇게 가려진 채
// 함께 오고, 이 함수는 그 요약을 그대로 모델에 전달할 뿐 원본 자료에 접근하지 않습니다.
//
// 배포:  supabase functions deploy ai-assessment
// 비밀 설정:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 모델 단가(USD / 1M 토큰). 비용 계산·상한 판단에 씁니다. 모델을 바꾸면 여기도 맞추세요.
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-opus-5": { in: 5, out: 25 },
};
// 기본값은 가장 저렴한 모델(입력 $1 / 출력 $5 per 1M). 월 상한 $7(≈₩10,000)과 함께 씁니다.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  // supabase-js 가 자동으로 붙이는 헤더까지 전부 허용해야 합니다. 하나라도 빠지면
  // 브라우저가 사전 확인(preflight)에서 막아, 함수는 멀쩡한데 화면에서만
  // "Failed to send a request to the Edge Function" 이 납니다.
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST만 허용됩니다" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_KEY) return json({ error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다" }, 500);

  // 1) 호출자 확인 — 승인된 직원만. (화면에서 로그인 JWT를 함께 보냅니다)
  const authHeader = req.headers.get("Authorization") ?? "";
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: approved, error: authErr } = await asCaller.rpc("is_approved_user");
  if (authErr || approved !== true) {
    return json({ error: "승인된 직원만 사용할 수 있습니다" }, 403);
  }

  // service_role 클라이언트 — 사용량 기록·판단 저장·상한 조회용(RLS 우회, 서버 안에서만).
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // 2) 비용 상한 확인 — 넘었으면 호출하지 않고 멈춥니다.
  const [{ data: capRow }, { data: spend }] = await Promise.all([
    admin.from("app_settings").select("value").eq("key", "ai_monthly_cap_usd").maybeSingle(),
    admin.rpc("ai_month_spend"),
  ]);
  const cap = Number((capRow?.value as { cap?: number } | null)?.cap ?? 7);
  const spent = Number(spend ?? 0);
  if (spent >= cap) {
    return json({ paused: true, reason: "월 비용 상한 도달", spent, cap });
  }

  // 3) 입력 — 어르신 "한 명"의 요약(가린 자료)만 받습니다.
  const payload = await req.json().catch(() => null);
  const residentId: string | undefined = payload?.residentId;
  const summary: string | undefined = payload?.summary; // 화면이 만든 가린 요약
  const model: string = payload?.model ?? DEFAULT_MODEL;
  const price = MODEL_PRICES[model] ?? MODEL_PRICES[DEFAULT_MODEL];

  // ── 확인 기록 분류 모드 ──────────────────────────────────────
  //
  // 담당자가 통화하고 적은 한 줄을 읽어, 결과 갈래·복귀 예정일·안심 기간을 채워 줍니다.
  // 판정이 아니라 **받아쓰기 거들기**입니다 — 제안만 하고, 반영은 담당자가 눌러야 됩니다.
  //
  // 왜 규칙만으로는 부족한가: 지금도 정규식이 대부분을 잡습니다. 그런데 실제로
  // "특이사항 없음"의 '특이사항'을 '이사'로 읽어 어르신을 영구 제외시킨 사고가 났습니다.
  // 사람이 쓰는 말은 규칙으로 다 못 막습니다. 그래서 규칙이 헷갈려 할 때만 부릅니다.
  //
  // 개인정보: 확인 기록 원문이 여기로 옵니다. 화면에서 이름처럼 보이는 글자를 가리고 보내고,
  // 아래 프롬프트에서도 이름을 되뇌지 말라고 못박습니다. 원문은 저장하지 않습니다.
  if (payload?.mode === "classify") {
    const note: string = String(payload?.note ?? "").slice(0, 1000);
    const today: string = String(payload?.today ?? "").slice(0, 10);
    if (!note.trim()) return json({ error: "적으신 내용이 없습니다" }, 400);

    const classifySystem = [
      "당신은 노인복지관 담당자가 통화 뒤 적은 한 줄을 읽고, 기록 칸을 대신 채워 주는 조력자입니다.",
      "",
      "아래 갈래 중 하나를 고르세요. 정확히 이 글자 그대로 씁니다.",
      "위기 / 사망 / 요양원입소 / 이사전출 / 급식자격상실 / 타기관이용 / 일자리프로그램참여 / 일시적사정 / 이용감소 / 확인불가",
      "",
      "무엇을 뜻하는가",
      "· 위기 — 입원·낙상·수술·질환처럼 지금 도움이 필요한 상태",
      "· 사망 / 요양원입소 / 이사전출 / 급식자격상실 — 더 이상 오실 수 없게 된 경우(명단에서 빠집니다)",
      "· 타기관이용 — 경로당 등 다른 곳에서 식사하고 계심",
      "· 일자리프로그램참여 — 노인일자리·프로그램 때문에 못 오심",
      "· 일시적사정 — 명절·집안일·더위처럼 곧 돌아오실 사정",
      "· 이용감소 — 기력이 없어 예전만큼 자주 못 오심(끊긴 것은 아님)",
      "· 확인불가 — **어르신이 지금 어떠신지 확인하지 못한 경우**",
      "",
      "── 둘 이상이 겹칠 때 무엇을 고르는가 ──",
      "",
      "한 문장에 여러 갈래가 섞여 나옵니다. **더 또렷하고 더 무거운 쪽**을 고르세요.",
      "",
      "  사망 › 요양원입소 › 이사전출 › 급식자격상실 › 위기 › 타기관이용 ›",
      "  일자리프로그램참여 › 이용감소 › 일시적사정",
      "",
      "일시적사정이 맨 뒤인 까닭: 「며칠」·「한동안」·「손주」·「다녀오」는 어느 이야기에나",
      "딸려 나오는 말입니다. 그 말이 있다고 일시적사정을 고르면 정작 중요한 것을 놓칩니다.",
      "일시적사정은 **다른 어느 갈래도 아닐 때** 고르는 자리입니다.",
      "",
      '  예) "한동안 못 나오심. 무릎 수술하셨다고 본인이 말씀하심"',
      "      → 중요한 말은 「한동안」이 아니라 「수술」입니다 → **위기**",
      '  예) "며칠 전 요양원 입소하셨다고 배우자분이 알려주심"',
      "      → 「며칠」이 아니라 「입소」입니다 → **요양원입소**",
      '  예) "손주 돌보시다 낙상하셔서 입원 중이심"',
      "      → 「손주」가 아니라 「낙상·입원」입니다 → **위기**",
      "",
      "── 요양원은 「들어가셨다」가 있을 때만 요양원입소 ──",
      "",
      "「요양원」이라는 낱말이 나왔다고 입소가 아닙니다. 알아보는 중·대기·상담·문의·고민은",
      "**아직 댁에 계신 분**이고, 오히려 지금 위태로운 분입니다.",
      "",
      '  예) "치매 증상 있어 요양원 알아보는 중" → **위기** (입소 아님)',
      '  예) "지난주 요양원 들어가셨다고 하심"    → **요양원입소**',
      "",
      "── 「확인불가」를 언제 쓰는가 — 이 순서대로 판단하세요 ──",
      "",
      "확인불가의 뜻은 하나입니다: **어르신이 지금 어떠신지 확인하지 못했다.**",
      "「연락이 닿았나」가 아니라 「확인이 됐나」로 가릅니다. 순서대로 물으세요.",
      "",
      "1) **아무에게도** 닿지 못했나? (전화 안 받음·없는 번호·부재, 그리고 달리 물어본 데도 없음)",
      "   → **확인불가.** 연락 불가는 해제 사유가 아니라 그 자체로 위기 신호입니다.",
      "   ※ 어르신 번호가 안 되더라도 **다른 분과는 통화가 됐다면 여기가 아닙니다.**",
      "     비상 연락처·배우자·보호자·자녀·이웃·주민센터 어느 쪽이든 닿아서 사정을",
      "     알아냈다면 2번이나 3번으로 내려가세요. 담당자가 수소문해서 알아낸 것을",
      "     '연락이 닿지 않았다'로 적으면 그 수고가 없었던 일이 됩니다.",
      "",
      "2) 연락은 됐는데, 들은 말이 **전해 들은 이야기**인가?",
      "   가르는 기준은 **누가 말했나**입니다.",
      "   · 배우자·자녀·보호자·유가족이 말한 것 → 전언이 아닙니다. 그분들은 사실을 압니다.",
      "   · 이웃·지인·소문·「…라더라」        → 전언입니다.",
      '   예) "요양원 입소하셨다고 배우자분이 알려주심" → 전언 아님 → **요양원입소**',
      '   예) "이웃 말로는 요양원 가셨다고 함"         → 전언 → **확인불가**',
      "   → 그 내용이 **명단에서 빼는 갈래**(사망·요양원입소·이사전출·급식자격상실·",
      "     타기관이용)라면 **확인불가**입니다. 한 번 빠지면 자동으로 돌아오지 않는데,",
      "     전해 들은 말로 그러면 안 됩니다.",
      "   → 명단에 남는 갈래(위기·일시적사정·이용감소)라면 전언이어도 그 갈래를 고르세요.",
      "     어차피 계속 지켜보므로 위험하지 않습니다.",
      "",
      "3) 어르신 본인이나 가족에게 **직접** 사정을 들었나?",
      "   → **확인불가가 아닙니다.** 앞으로 어떻게 될지 확실하지 않더라도 들은 내용에",
      "     가장 가까운 갈래를 고르세요. 담당자가 통화해서 알아낸 것을 '확인 못 함'으로",
      "     적으면 그 통화가 없었던 일이 됩니다.",
      "     · 입원·수술·낙상을 들었으면 → 위기",
      "     · 자녀 집·명절·더위처럼 곧 돌아오실 사정이면 → 일시적사정",
      "     · 기력이 없어 예전만큼 못 오신다면 → 이용감소",
      "",
      '   예) 이웃이 전화를 받아 "요양원 가셨대요" → 1번 아님(연락은 됨), 2번 해당',
      "       (전언 + 명단에서 빼는 갈래) → **확인불가**",
      '   예) 따님이 받아 "어머니 입원하셨어요" → 3번 해당(가족에게 직접) → **위기**',
      '   예) "없는 번호로 확인되어 비상 연락처 확인하여 배우자와 통화함. 8월에 사망하심"',
      "       → 1번 아님(번호는 결번이지만 배우자와 통화가 됐습니다). 3번 해당 —",
      "       배우자에게 **직접** 들었으므로 전언이 아닙니다 → **사망**",
      "",
      "그 밖에 반드시 지켜주세요.",
      "· 갈래가 애매할 때 조심할 것은 **명단에서 빼는 쪽**(사망·요양원입소·이사전출·",
      "  급식자격상실·타기관이용)뿐입니다. 이쪽은 확실할 때만 고르고, 아니면 곁의 갈래를",
      "  고르세요. 한 번 빠지면 자동으로 돌아오지 않습니다.",
      "· 이름·주소를 답에 쓰지 마세요. 기억하거나 되뇌지도 마세요.",
      "",
      "복귀 예정일(resumeExpected)",
      `· 오늘은 ${today} 입니다. "추석 지나고", "다음 주에" 처럼 시점이 적혀 있으면 YYYY-MM-DD 로 바꾸세요.`,
      "· 적혀 있지 않으면 null 로 두세요. 짐작해서 만들지 마세요.",
      "· ★ **명절·연휴·행사처럼 여러 날에 걸친 일이면, 끝난 바로 다음 날로 잡지 마세요.**",
      "  일주일쯤 여유를 두고 잡으세요. 현장에서 명절은 딱 끝나지 않습니다 — 자녀 집에",
      "  며칠 더 계시거나, 오가느라 지쳐 한 주 쉬시는 일이 보통입니다. 연휴 다음 날로",
      "  잡으면 아직 오실 때가 아닌 분이 그 다음날 위기로 다시 올라오고, 담당자가 헛걸음",
      "  합니다. 그런 일이 몇 번 반복되면 담당자가 목록 전체를 안 믿게 됩니다.",
      '  · "추석 지나고 나오신다"  → 연휴 마지막 날이 아니라 그로부터 **일주일 뒤**',
      '  · "김장 끝나면", "농사철 지나고" 도 같습니다 — 끝나는 날을 딱 집지 마세요.',
      '· 반대로 "다음 주 화요일", "10월 5일" 처럼 **날짜를 콕 집어 말씀하신 경우**에는',
      "  그대로 쓰세요. 여유는 기간이 흐릿할 때만 둡니다.",
      "",
      "안심 기간(snoozeDays) — 며칠 동안 위기 목록에서 빼둘지",
      "· 확인불가 3 · 위기 14 · 일시적사정 14 · 일자리프로그램참여 30 · 이용감소 30",
      "· 종료 계열(사망·요양원입소·이사전출·급식자격상실·타기관이용)은 0",
      "· 복귀 예정일이 있으면 그날까지가 우선이니 snoozeDays 는 그대로 두세요.",
      "",
      "── 글로 써야 하는 네 가지 ───────────────────────────────",
      "",
      "담당자는 통화를 막 끝내고 급하게 적었습니다. 그 몇 줄을 읽고, 이 어르신을 앞으로",
      "어떻게 봐야 하는지 정리해 주세요. 갈래만 찍어주는 것은 도움이 되지 않습니다.",
      "",
      "1) situation — 적으신 내용을 시간 순서로 꿴 두세 문장.",
      "   흩어져 적힌 것을 '언제 → 무슨 일 → 지금 어떤 상태'로 정리합니다.",
      "   예: 8월에 입원하셨다가 9월 초 퇴원하셨고, 지금은 서울 따님 댁에 계십니다.",
      "       복귀 시점은 정해지지 않았습니다.",
      "",
      "2) nextAction — 담당자가 다음에 실제로 할 일 한두 가지.",
      "   '지켜보세요' 같은 말은 쓰지 마세요. 언제·무엇을·왜 하는지 적습니다.",
      "   예: 한 달 뒤 따님께 다시 연락해 거처가 그대로인지 확인해 주세요. 서울 체류가",
      "       길어지면 이사·전출로 볼지 판단해야 합니다.",
      "   · 연락이 안 됐다면 → 언제 다시 걸지, 그래도 안 되면 무엇을 할지",
      "   · 입원·수술이었다면 → 퇴원 뒤 언제 확인할지",
      "   · 명단에서 빼는 갈래라면 → 무엇을 더 확인하고 빼야 하는지",
      "",
      "3) watchOut — 이 기록에서 놓치기 쉬운 점 한 문장. 없으면 빈 문자열.",
      "   나빠질 낌새, 확인이 덜 된 부분, 기록에서 빠진 것을 짚어 주세요.",
      "   예: '언제 올지 모른다'는 말은 이용을 그만두시는 앞단계일 수 있습니다.",
      "   예: 따님 연락처가 기록에 없습니다. 다음 확인을 위해 받아두시면 좋겠습니다.",
      "",
      "4) reason — 왜 그 갈래로 봤는지 한 문장.",
      "",
      "존댓말로 담백하게. 자료에 없는 사실을 지어내지 마세요. 단정하지 말고 '확인이",
      "필요합니다'처럼 씁니다. 굵은 글씨·목록 기호·제목은 붙이지 마세요.",
      "",
      "오직 아래 모양의 JSON 하나만 답하세요. 설명도 코드블록도 붙이지 마세요.",
      '{"resultKind":"...","resumeExpected":null,"snoozeDays":0,"situation":"...","nextAction":"...","watchOut":"...","reason":"...","confidence":"high|low"}',
    ].join("\n");

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 900,
          // ★ 0 으로 둡니다. 여기서 AI가 하는 일은 담당자가 쓴 문장을 갈래·날짜로 옮겨
          //   적는 것이지 글을 짓는 것이 아닙니다. 기본값(1)이면 같은 메모를 두 번 보냈을
          //   때 다른 갈래가 나올 수 있고, 그러면 "같은 자료를 넣으면 같은 결과"라는 이
          //   도구의 약속이 AI가 닿는 자리에서만 깨집니다.
          temperature: 0,
          system: classifySystem,
          messages: [{ role: "user", content: note }],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return json({ error: "AI 호출 실패", detail: data?.error?.message ?? resp.status }, 502);
      }
      const text = (data.content ?? [])
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("")
        .trim();

      // 코드블록이나 군말이 섞여 와도 JSON 덩어리만 꺼냅니다.
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return json({ error: "AI 응답을 읽지 못했습니다", raw: text.slice(0, 200) }, 502);
      const parsed = JSON.parse(m[0]);

      // 아는 갈래인지 확인합니다. 모르는 값이 오면 가장 보수적인 쪽으로 둡니다 —
      // 엉뚱한 갈래로 어르신이 명단에서 빠지는 것이 최악입니다.
      const KINDS = [
        "위기",
        "사망",
        "요양원입소",
        "이사전출",
        "급식자격상실",
        "타기관이용",
        "일자리프로그램참여",
        "일시적사정",
        "이용감소",
        "확인불가",
      ];
      const kind = KINDS.includes(parsed?.resultKind) ? parsed.resultKind : "확인불가";
      const resume =
        typeof parsed?.resumeExpected === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.resumeExpected)
          ? parsed.resumeExpected
          : null;

      const inTokC = data.usage?.input_tokens ?? 0;
      const outTokC = data.usage?.output_tokens ?? 0;
      const costC = (inTokC * price.in + outTokC * price.out) / 1_000_000;
      await admin.from("ai_usage").insert({
        resident_id: null,
        model,
        input_tokens: inTokC,
        output_tokens: outTokC,
        cost_usd: costC,
      });

      return json({
        ok: true,
        mode: "classify",
        resultKind: kind,
        resumeExpected: resume,
        snoozeDays: Number.isFinite(parsed?.snoozeDays) ? Number(parsed.snoozeDays) : 0,
        situation: typeof parsed?.situation === "string" ? parsed.situation.slice(0, 600) : "",
        nextAction: typeof parsed?.nextAction === "string" ? parsed.nextAction.slice(0, 600) : "",
        watchOut: typeof parsed?.watchOut === "string" ? parsed.watchOut.slice(0, 400) : "",
        reason: typeof parsed?.reason === "string" ? parsed.reason.slice(0, 300) : "",
        confidence: parsed?.confidence === "high" ? "high" : "low",
        cost: costC,
        spent: spent + costC,
        cap,
      });
    } catch (e) {
      return json({ error: "AI 호출 중 오류", detail: String(e) }, 502);
    }
  }

  if (!residentId || !summary) {
    return json({ error: "residentId 와 summary(가린 요약)가 필요합니다" }, 400);
  }
  // 회원번호 꼴(2019-00123)인지 확인합니다. 아래에서 이 값을 그대로 service_role 로
  // residents 를 UPDATE 하는 데 쓰기 때문에, 형식이 아닌 것은 여기서 끊습니다.
  if (!/^\d{4}-\d{3,7}$/.test(residentId)) {
    return json({ error: "residentId 형식이 올바르지 않습니다" }, 400);
  }

  // 4) Claude 호출 — 1인 1건. 짧은 한국어 코멘트를 요청합니다.
  // 무엇을 맡기고 무엇을 안 맡기는가 — 이 구분이 이 기능의 전부입니다.
  //
  //   판정(위기/주의/관찰)  → 로직이 합니다. 절벽점수·기준선·연속결석으로 이미 끝났습니다.
  //   설명(왜 그런지)       → AI가 합니다. 숫자와 외부변수를 사람 말로 엮습니다.
  //
  // 이렇게 나눈 이유: 판정을 AI에 맡기면 같은 어르신이 부를 때마다 다른 등급을 받습니다.
  // 근거를 댈 수 없는 판정은 현장에서 못 씁니다. 반대로 설명을 템플릿으로 찍어내면 400분이
  // 다 똑같이 읽혀서 아무도 안 읽습니다. 그래서 정하는 것은 로직, 풀어 쓰는 것은 AI입니다.
  const system = [
    "당신은 노인복지관 사례관리 담당자를 돕는 조력자입니다.",
    "",
    "중요: 위기 여부는 이미 정해졌습니다. 당신이 등급을 매기거나 뒤집지 마세요.",
    "당신이 할 일은 담당자가 연락하기 전에 읽을 **3~4문장짜리 설명**을 쓰는 것입니다.",
    "",
    "이렇게 써주세요.",
    "· 무엇이 평소와 다른지 한 문장.",
    "· 안 나오신 기간에 설명될 만한 사정(날씨·행사)이 있었는지 한 문장. 사정이 하나도",
    "  없었다면 그 사실 자체가 중요하니 분명히 적어주세요.",
    "· 지난 확인 기록이 있으면, 그때 일과 지금이 어떻게 이어지는지 한 문장.",
    "  「재발 N회째」라고 적혀 있으면 **반드시** 짚어주세요. 한 번 끊긴 것과 연락이 닿아",
    "  돌아오셨다가 또 끊기는 것은 담당자가 할 일이 다릅니다. 지난번에 들으신 사유가",
    "  이번에도 같은지 다른지도 짚어주면 좋습니다.",
    "· 담당자가 먼저 무엇을 확인하면 좋을지 한 문장.",
    "",
    "지켜주세요.",
    "· 받은 자료에 없는 사실을 지어내지 마세요. 병명·가족관계·사는 형편을 추측하지 마세요.",
    "· 「적어 둔 내용」은 담당자가 직접 쓴 기록이니 사실로 다뤄도 됩니다. 다만 '~다고 함',",
    "  '들었다', '소문' 처럼 **전해 들은 표시**가 있으면 확정하지 말고 전언 그대로 적으세요.",
    "  ○○ 로 가려진 자리는 이름입니다. 그 자리를 채우려 하지 마세요.",
    "· **사람 이름을 답에 쓰지 마세요.** 이름은 가려서 보내지만 가리기가 완전하지 않아,",
    "  받은 글에 실명이 남아 있을 수 있습니다. 보이더라도 옮겨 적지 말고 '어르신',",
    "  '따님', '이웃분'처럼 관계로만 부르세요. 주소·전화번호도 마찬가지입니다.",
    "· 단정하지 마세요. '위독합니다'가 아니라 '확인이 필요합니다'로 씁니다.",
    "· 존댓말로, 담백하게. 어르신을 '어르신'이라고 부릅니다.",
    "· **숫자 점수·확률·퍼센트를 답에 쓰지 마세요.** '19일째', '주 3회' 같은 사실은 괜찮지만",
    "  '확률 0.00%', '위험도 18점' 처럼 계산값을 그대로 옮기면 안 됩니다. 화면에 점수를",
    "  드러내지 않기로 한 도구입니다.",
    "· 제목이나 머리말을 붙이지 마세요. 굵은 글씨·목록 기호도 쓰지 마세요.",
    "  화면의 한 칸에 그대로 들어가는 글이라, 제목이 붙으면 줄만 잡아먹습니다.",
    "  문장 서너 개만 이어서 쓰세요.",
  ].join("\n");

  let aiText = "";
  let inTok = 0;
  let outTok = 0;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        // ★ 설명 문장도 0 입니다. 같은 어르신을 두 번 열었을 때 다른 말이 나오면
        //   담당자는 어느 쪽을 믿어야 할지 알 수 없습니다.
        temperature: 0,
        system,
        messages: [{ role: "user", content: summary }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return json({ error: "AI 호출 실패", detail: data?.error?.message ?? resp.status }, 502);
    }
    aiText = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n")
      .trim();
    inTok = data.usage?.input_tokens ?? 0;
    outTok = data.usage?.output_tokens ?? 0;
  } catch (e) {
    return json({ error: "AI 호출 중 오류", detail: String(e) }, 502);
  }

  // 5) 사용량 기록(상한의 근거) + 판단 저장 + 플래그 해제.
  const cost = (inTok * price.in + outTok * price.out) / 1_000_000;
  await admin.from("ai_usage").insert({
    resident_id: residentId,
    model,
    input_tokens: inTok,
    output_tokens: outTok,
    cost_usd: cost,
  });
  await admin
    .from("residents")
    .update({
      ai_summary: aiText,
      ai_summary_at: new Date().toISOString(),
      ai_summary_model: model,
      ai_needs_update: false,
    })
    .eq("id", residentId);

  const newSpent = spent + cost;
  return json({
    ok: true,
    residentId,
    summary: aiText,
    model,
    cost,
    spent: newSpent,
    cap,
    // 이번 호출로 상한을 넘었으면 화면에 알려 다음부터 멈추게 합니다.
    reachedCap: newSpent >= cap,
  });
});
