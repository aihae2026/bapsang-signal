// 음성 인식 결과를 고를 때 쓰는 현장 어휘.
//
// 크롬의 음성 인식은 한 번 말할 때마다 후보를 여러 개 내놓습니다. 지금까지는 첫 번째만
// 썼는데, 첫 번째가 늘 맞지는 않습니다. 특히 "기력이 없으심", "거동이 불편하심" 같은
// 복지 현장 말투는 일반 대화보다 드물어서 뒤 순위로 밀리는 경우가 있습니다.
//
// 그래서 후보들을 이 어휘로 채점해 가장 현장 말투에 가까운 것을 고릅니다.
//
// ⚠️ 중요 — 이건 **고르기**이지 **고치기**가 아닙니다. 크롬이 내놓지 않은 말을 만들어내지
//    않습니다. 잘못 들은 단어를 우리가 임의로 바꾸면, 어르신에 대한 기록이 실제로 하지 않은
//    말로 남습니다. 그건 관찰 기록으로서 위험합니다. 후보 중에서만 고릅니다.

/** 메모 자동 분류에 쓰이는 말들. 이게 들어간 후보를 고르면 분류까지 정확해집니다. */
const TAG_WORDS = [
  "어지럽",
  "통증",
  "아프",
  "기력이 없",
  "컨디션 난조",
  "말수",
  "표정이 어둡",
  "우울",
  "무기력",
  "외롭",
  "의욕이 없",
  "병원",
  "진료",
  "외출",
  "경조사",
  "여행",
  "아드님",
  "손주",
  "자녀",
  "딸",
  "아들",
  "면회",
  "가족",
  "연속으로 결석",
  "입원",
  "응급",
  "위독",
  "연락이 잘 닿지",
  "좋아 보",
  "회복",
  "웃음",
  "밝아",
  "건강 체조",
];

/** 분류에는 안 쓰이지만 현장에서 자주 나오는 말들. */
const FIELD_WORDS = [
  "어르신",
  "식사",
  "국물",
  "반찬",
  "밥",
  "드셨",
  "드시",
  "잡수",
  "무릎",
  "허리",
  "다리",
  "거동",
  "지팡이",
  "보행기",
  "복지관",
  "경로식당",
  "도시락",
  "결석",
  "출석",
  "전화",
  "통화",
  "방문",
  "댁",
  "혼자",
  "약",
  "혈압",
  "당뇨",
  "감기",
  "낙상",
  "넘어지",
  "기침",
  "잠",
  "식욕",
];

/** 어르신을 높여 부르는 말끝. 이 말투가 살아 있는 후보가 대개 옳습니다. */
const HONORIFIC_ENDINGS = [
  "하심",
  "하십니다",
  "하셨",
  "이심",
  "으심",
  "십니다",
  "셨습니다",
  "세요",
];

/**
 * 후보 하나에 점수를 매깁니다. 높을수록 현장 말투에 가깝습니다.
 *
 * 가중치를 다르게 준 이유: 분류에 쓰이는 말(TAG_WORDS)이 맞아야 메모가 올바른 태그를 달고
 * 위기 판단에 들어갑니다. 그래서 그쪽을 더 무겁게 봅니다.
 */
export function scoreTranscript(text: string): number {
  if (!text) return 0;
  let score = 0;
  for (const w of TAG_WORDS) if (text.includes(w)) score += 3;
  for (const w of FIELD_WORDS) if (text.includes(w)) score += 1.5;
  for (const e of HONORIFIC_ENDINGS) if (text.includes(e)) score += 1;
  // 너무 짧게 끊긴 후보는 대개 잘못 들은 것입니다.
  if (text.trim().length >= 6) score += 0.5;
  return score;
}

/**
 * 후보 중 가장 나은 것을 고릅니다.
 *
 * 동점이면 크롬이 1순위로 준 것을 그대로 씁니다 — 우리 어휘에 걸리는 말이 하나도 없을 때
 * 순서를 흔들 근거가 없습니다.
 */
export function pickBestTranscript(candidates: string[]): string {
  if (candidates.length === 0) return "";
  let best = candidates[0];
  let bestScore = scoreTranscript(candidates[0]);
  for (let i = 1; i < candidates.length; i++) {
    const s = scoreTranscript(candidates[i]);
    if (s > bestScore) {
      best = candidates[i];
      bestScore = s;
    }
  }
  return best;
}

/**
 * 받아쓴 조각을 앞 문장 뒤에 붙입니다.
 *
 * 그냥 이어 붙이면 "오늘은말수가적으시고" 처럼 달라붙거나 공백이 겹칩니다. 문장이 끝나는
 * 말끝(…하심, …습니다 등)이면 마침표를 찍어 다음 문장과 구분해 줍니다 — 나중에 사람이
 * 읽을 때도, 자동 분류가 문장을 나눌 때도 도움이 됩니다.
 */
export function appendSpoken(previous: string, spoken: string): string {
  const add = spoken.trim().replace(/\s+/g, " ");
  if (!add) return previous;
  const base = previous.trimEnd();
  if (!base) return add;
  const endsSentence = /[.!?…]$/.test(base) || HONORIFIC_ENDINGS.some((e) => base.endsWith(e));
  return endsSentence && !/[.!?…]$/.test(base) ? `${base}. ${add}` : `${base} ${add}`;
}
