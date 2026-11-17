import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Mic, Square, Undo2 } from "lucide-react";
import { pickBestTranscript } from "@/lib/voice-vocabulary";

/**
 * 말하면 글로 적어주는 버튼. **휴대폰이 주 사용 환경**이라는 전제로 만들었습니다.
 *
 * 설계근거 문서 4.2의 요구입니다 — 확인 기록이 쌓이지 않으면 이 시스템의 핵심(자연어 해석)이
 * 아예 작동하지 않는데, 지금 그 정보는 담당자 머릿속에만 있습니다. "입력이 30초를 넘으면
 * 현장에서 쓰이지 않는다"를 전제로, 타이핑 대신 말로 남길 수 있게 합니다.
 *
 * 브라우저에 내장된 음성 인식(Web Speech API)을 씁니다. 우리가 따로 낼 요금은 없습니다.
 *
 * ⚠️ 다만 "브라우저 내장"이 "기기 안에서 처리된다"는 뜻은 아닙니다. 크롬의 Web Speech API 는
 *    음성을 **구글 음성 인식 서버로 보내서** 글자로 바꿉니다. 즉 이 단추로 받아 적는 상담
 *    내용은 구글을 한 번 거칩니다. 예전 주석은 "서버로 음성을 보내지 않는다"고 적혀 있었는데
 *    사실이 아니었습니다. 어르신 실명이나 병명을 말로 남기실 때는 이 점을 감안하십시오.
 *
 * ── 안드로이드에서 마이크 허가가 계속 뜨고 말이 다섯 번씩 들어가던 문제 ──
 * 두 증상의 뿌리가 같습니다. **안드로이드 크롬은 continuous 모드를 제대로 지원하지
 * 않습니다.** 한 마디가 끝나면 인식이 스스로 종료되는데, 예전 코드는 그때마다 onend에서
 * 다시 start() 했습니다. 그래서
 *
 *   · 다시 켤 때마다 마이크 허가·안내가 뜨고
 *   · 안드로이드가 같은 발화를 results 배열에 겹쳐 쌓아, 늘어난 부분만 넘겨도
 *     같은 말이 두 번, 세 번, 다섯 번 들어갔습니다.
 *
 * 그래서 휴대폰에서는 **continuous 를 끄고 자동 재시작도 하지 않습니다.** 한 번 누르면
 * 한두 문장을 받아 적고 스스로 멈추고, 더 말할 게 있으면 다시 누릅니다. 이게 안드로이드가
 * 실제로 지원하는 방식이고, 허가창도 한 번만 뜹니다.
 *
 * 데스크톱(크롬·엣지)은 continuous 가 제대로 동작하므로 그대로 이어 듣습니다.
 *
 * ── 그래도 남을 수 있는 중복에 대한 방어 ───────────────────
 * 기기·버전마다 동작이 조금씩 달라, 방금 넣은 것과 똑같은 말이 곧바로 또 오면 버립니다.
 * 사람이 같은 짧은 말을 2초 안에 두 번 하는 경우보다, 기기가 같은 말을 두 번 주는 경우가
 * 훨씬 흔합니다.
 *
 * ── 인식 정확도 ────────────────────────────────────────────
 * 엔진 자체는 크롬 것이라 바꿀 수 없습니다. 대신 크롬이 내놓는 여러 후보 중에서 현장 어휘로
 * 채점해 고릅니다(voice-vocabulary.ts). 고르기이지 고치기가 아닙니다 — 크롬이 내놓지 않은
 * 말은 만들지 않습니다. 임의로 바꾸면 어르신이 하지 않은 말이 기록으로 남습니다.
 */

interface AlternativeLike {
  transcript: string;
}
interface ResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: AlternativeLike;
}
interface RecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: ResultLike };
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => RecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * 휴대폰인가.
 *
 * 화면 폭이 아니라 기기로 판정합니다. 태블릿을 가로로 눕히면 화면은 넓지만 음성 인식 동작은
 * 여전히 모바일 방식이기 때문입니다.
 */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

/** 한 결과의 후보들을 모아 가장 나은 것을 고릅니다. */
function bestOf(result: ResultLike): string {
  const candidates: string[] = [];
  for (let i = 0; i < result.length; i++) {
    const t = result[i]?.transcript;
    if (t) candidates.push(t);
  }
  return pickBestTranscript(candidates);
}

export function VoiceDictateButton({
  onAppend,
  onUndo,
  disabled,
  className = "",
}: {
  /** 확정된 문장을 넘겨줍니다. 앞 문장과 자연스럽게 이어 붙여 돌려주세요. */
  onAppend: (spoken: string) => void;
  /** "방금 받아쓴 것 지우기"를 눌렀을 때. 없으면 그 버튼이 안 보입니다. */
  onUndo?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  // 서버 렌더링 때는 window가 없어 판정할 수 없습니다. 처음엔 감춰두고 브라우저에서 켜야
  // 서버·브라우저의 첫 화면이 달라지지 않습니다(하이드레이션 불일치 방지).
  const [supported, setSupported] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [spokeSomething, setSpokeSomething] = useState(false);

  const recognitionRef = useRef<RecognitionLike | null>(null);
  const wantListeningRef = useRef(false);
  const mobileRef = useRef(false);
  // 이번 세션에서 지금까지 확정된 전체 문장. 중복 방지의 1차 방어선입니다.
  const sessionFinalRef = useRef("");
  // 방금 넘긴 말과 그 시각. 기기가 같은 말을 또 줄 때의 2차 방어선입니다.
  const lastSpokenRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  // onresult 안에서 부모의 최신 함수를 쓰기 위한 통로.
  const onAppendRef = useRef(onAppend);
  onAppendRef.current = onAppend;

  useEffect(() => {
    setSupported(!!getRecognitionCtor());
    const m = isMobileDevice();
    setMobile(m);
    mobileRef.current = m;
    return () => {
      wantListeningRef.current = false;
      recognitionRef.current?.abort();
    };
  }, []);

  /** 중복을 걸러 부모에게 넘깁니다. */
  const emit = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const now = Date.now();
    const last = lastSpokenRef.current;
    // 방금 넣은 것과 똑같은 말이 2초 안에 또 오면 기기가 준 중복으로 봅니다.
    if (clean === last.text && now - last.at < 2000) return;
    lastSpokenRef.current = { text: clean, at: now };
    onAppendRef.current(clean);
    setSpokeSomething(true);
  };

  const stop = () => {
    wantListeningRef.current = false;
    recognitionRef.current?.stop();
    setListening(false);
  };

  const start = () => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    // 이미 듣고 있으면 새로 만들지 않습니다. 두 개가 동시에 돌면 모든 말이 두 번 들어옵니다.
    if (recognitionRef.current && wantListeningRef.current) return;

    const onMobile = mobileRef.current;
    const recognition = new Ctor();
    recognition.lang = "ko-KR";
    // 휴대폰에서는 끕니다. 안드로이드가 이 모드를 제대로 지원하지 않아, 켜두면 같은 말이
    // 여러 번 들어오고 재시작 때마다 마이크 안내가 뜹니다.
    recognition.continuous = !onMobile;
    recognition.interimResults = true;
    // 후보를 여럿 받아 현장 말투에 가장 가까운 것을 고릅니다. 하나만 받으면 고를 수가 없습니다.
    recognition.maxAlternatives = 6;

    recognition.onstart = () => {
      sessionFinalRef.current = "";
    };

    recognition.onresult = (event) => {
      let finalAll = "";
      let interimAll = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalAll += bestOf(result);
        else interimAll += result[0]?.transcript ?? "";
      }

      const previous = sessionFinalRef.current;
      if (finalAll.startsWith(previous)) {
        const added = finalAll.slice(previous.length);
        sessionFinalRef.current = finalAll;
        emit(added);
      } else if (finalAll !== previous) {
        // 드물게 크롬이 앞 문장을 다시 해석해 바꾸는 경우입니다. 전체를 다시 넘기면 중복이
        // 되므로 기준만 맞추고 넘기지 않습니다.
        sessionFinalRef.current = finalAll;
      }
      setInterim(interimAll);
    };

    recognition.onerror = (event) => {
      // no-speech: 잠깐 조용했던 것뿐입니다. 휴대폰에서는 그대로 끝내고(다시 누르면 됩니다),
      // 데스크톱에서는 onend가 이어서 다시 켭니다.
      if (event.error === "aborted") return;
      if (event.error === "no-speech") {
        if (onMobile) {
          wantListeningRef.current = false;
          toast("소리가 들리지 않았습니다. 다시 눌러 말씀해주세요.");
        }
        return;
      }

      wantListeningRef.current = false;
      setListening(false);
      setInterim("");
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        toast.error(
          onMobile
            ? "마이크 사용을 허용해주세요. 주소창 왼쪽 자물쇠 → 권한 → 마이크에서 바꿀 수 있습니다."
            : "마이크 사용이 차단되어 있습니다. 주소창 왼쪽 자물쇠에서 허용해주세요.",
          { duration: 8000 },
        );
        return;
      }
      if (event.error === "audio-capture") {
        toast.error("마이크를 찾을 수 없습니다. 연결 상태를 확인해주세요.");
        return;
      }
      if (event.error === "network") {
        toast.error("음성 인식에 인터넷 연결이 필요합니다.");
        return;
      }
      toast.error("음성 인식에 문제가 생겼습니다. 다시 눌러주세요.");
    };

    recognition.onend = () => {
      // 아직 확정되지 않은 말이 남아 있으면 그것도 넣어줍니다. 이게 없으면 마지막 한 마디가
      // 사라집니다.
      setInterim((pending) => {
        emit(pending);
        return "";
      });

      // 휴대폰에서는 여기서 끝냅니다. 다시 켜면 마이크 안내가 또 뜨고 같은 말이 겹쳐 들어옵니다.
      if (onMobile || !wantListeningRef.current) {
        wantListeningRef.current = false;
        recognitionRef.current = null;
        setListening(false);
        return;
      }
      // 데스크톱은 몇 초 조용하면 크롬이 스스로 끊으므로 이어서 다시 켭니다.
      try {
        recognition.start();
      } catch {
        // 이미 돌고 있으면 예외가 납니다. 그냥 두면 됩니다.
      }
    };

    recognitionRef.current = recognition;
    wantListeningRef.current = true;
    sessionFinalRef.current = "";
    lastSpokenRef.current = { text: "", at: 0 };
    setInterim("");
    try {
      recognition.start();
      setListening(true);
    } catch {
      toast.error("음성 인식을 시작하지 못했습니다.");
      wantListeningRef.current = false;
      recognitionRef.current = null;
    }
  };

  if (!supported) return null;

  return (
    <div className={className}>
      {listening ? (
        <>
          <Button
            type="button"
            variant="destructive"
            onClick={stop}
            className="h-14 w-full text-base font-semibold"
          >
            <Square className="mr-2 h-4 w-4 fill-current" />
            {mobile ? "그만 듣기" : "다 말했습니다 · 받아쓰기 마치기"}
          </Button>
          <div className="mt-2 flex items-start gap-2.5 rounded-lg border-2 border-red-300 bg-red-50 px-3.5 py-3">
            {/* 듣고 있다는 표시. 이게 없으면 담당자가 말해도 되는지 몰라 멈칫합니다. */}
            <span className="relative mt-1.5 flex h-2.5 w-2.5 shrink-0">
              <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="h-2.5 w-2.5 rounded-full bg-red-600" />
            </span>
            <p className="text-[13px] leading-relaxed text-red-900">
              {interim ? (
                <span className="text-red-700">{interim}</span>
              ) : mobile ? (
                <>
                  <b className="font-semibold">듣고 있습니다.</b> 한두 문장 말씀해주세요.
                  <br />
                  <span className="text-red-700/70">말을 마치면 저절로 멈춥니다.</span>
                </>
              ) : (
                <>
                  <b className="font-semibold">듣고 있습니다.</b> 평소 말하듯 편하게 이야기해주세요.
                  <br />
                  <span className="text-red-700/70">
                    잠깐 쉬어도 계속 듣습니다. 다 말하면 위 버튼을 눌러주세요.
                  </span>
                </>
              )}
            </p>
          </div>
        </>
      ) : (
        <>
          {/* 이 도구에서 가장 중요한 입력 통로라 눈에 띄게 둡니다. 타이핑보다 이쪽을 먼저
              보게 해야 기록이 쌓입니다. */}
          <button
            type="button"
            onClick={start}
            disabled={disabled}
            className="voice-cta flex w-full items-center justify-center gap-3 rounded-xl border-2 border-primary/35 bg-primary/[0.07] px-4 py-3.5 text-primary transition-colors hover:border-primary/55 hover:bg-primary/[0.12] disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
              <Mic className="h-5.5 w-5.5" strokeWidth={2.2} />
            </span>
            <span className="text-left">
              <span className="block text-base font-bold leading-tight">
                {spokeSomething ? "이어서 더 말하기" : "말로 입력하기"}
              </span>
              <span className="block text-xs leading-snug text-primary/75">
                {spokeSomething
                  ? "누르고 다음 문장을 말씀하세요"
                  : "타이핑 대신 말씀만 하세요 · 가장 빠릅니다"}
              </span>
            </span>
          </button>

          <div className="mt-1.5 flex items-start justify-between gap-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {mobile
                ? "한 번 누르면 한두 문장을 받아 적고 저절로 멈춥니다. 더 말할 게 있으면 다시 눌러주세요. 받아쓰기는 크롬·엣지 기능이라 음성이 구글 서버를 거칩니다 — 어르신 성함은 말씀하지 마세요."
                : "크롬·엣지의 받아쓰기 기능을 씁니다. 음성이 구글 서버를 거쳐 글로 바뀌니 어르신 성함은 말씀하지 마세요. 받아쓴 내용은 저장 전에 고칠 수 있습니다."}
            </p>
            {onUndo && spokeSomething && (
              <button
                type="button"
                onClick={() => {
                  onUndo();
                  setSpokeSomething(false);
                  lastSpokenRef.current = { text: "", at: 0 };
                }}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Undo2 className="h-3 w-3" />
                받아쓴 것 지우기
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
