import type { Resident } from "@/lib/attendance-engine";

/**
 * 어르신 이름 옆에 회원번호를 함께 보여줍니다.
 *
 * 이름만으로는 누구인지 특정할 수 없습니다. 2,828분 중 이름이 겹치는 분이 있고, 게다가
 * 개인정보 보호를 위해 이름 가운데를 가려서(이○영) 저장하기 때문에 겹치는 경우가 더
 * 늘어납니다. "김○자"가 여러 분일 때, 담당자가 엉뚱한 분께 전화를 걸면 그 자체로 사고입니다.
 *
 * 회원번호는 앤컴에서 쓰는 번호 그대로라 그 화면에서 바로 찾아보실 수 있습니다.
 *
 * 글자 크기를 em 으로 잡은 이유: 이 컴포넌트가 큰 제목부터 작은 목록까지 두루 쓰이는데,
 * 고정 크기로 두면 어떤 자리에서는 번호가 이름보다 커 보입니다.
 */
export function ResidentName({ resident, className }: { resident: Resident; className?: string }) {
  // 첫 페인트 때 자료가 아직 안 온 순간이 있습니다. 그때 resident 가 없으면 잠깐 비워둡니다 —
  // 곧 자료가 도착해 다시 그려집니다.
  if (!resident) return null;
  return (
    <>
      {resident.name}
      <span
        className={`ml-1.5 text-[0.8em] font-normal tabular-nums text-muted-foreground ${className ?? ""}`}
      >
        {resident.id}
      </span>
    </>
  );
}

/** 알림 문구처럼 글자만 들어가는 자리에 씁니다. */
export function residentLabel(resident: Resident): string {
  if (!resident) return "";
  return `${resident.name} (${resident.id})`;
}

/**
 * 이름 아래 한 줄로 붙이는 부가 정보.
 *
 * 실제 자료에는 나이대·전화번호가 없어서 "미상"·"미등록"으로 들어가 있습니다. 그것을 그대로
 * 그리면 화면마다 "미상 · 미등록"이 붙어 아무 뜻도 없는 글자가 자리만 차지합니다.
 * 아는 것만 적고, 아무것도 모르면 줄 자체를 그리지 않습니다.
 */
export function residentSubtitle(resident: Resident): string {
  if (!resident) return "";
  // ★ 자료에 섞여 들어온 날짜 문자열을 화면에 찍지 않습니다.
  //
  //   가져오기 과정에서 Date 객체가 그대로 문자열이 된 값이 전화번호 칸에 들어와,
  //   이름 밑에 이렇게 찍혔습니다 —
  //     홍○녀 · Wed Jan 01 2020 00:00:00 GMT+0900 (한국 표준
  //   칸을 넘어가 중간에서 잘리기까지 했습니다. 자료를 고치는 것이 근본이지만,
  //   고칠 때까지 화면이 알아볼 수 없는 글자를 보여줄 이유는 없습니다.
  const looksLikeJsDate = (v: string) =>
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/.test(v) || /GMT[+-]\d{4}/.test(v);
  const parts = [resident.ageGroup, resident.phone].filter(
    (v) => v && v !== "미상" && v !== "미등록" && v !== "미지정" && !looksLikeJsDate(v),
  );
  return parts.join(" · ");
}

/**
 * 수급·저소득 표시.
 *
 * 무료급식·감면은 기초수급·차상위에 해당하는 분들입니다. 같은 정도로 발길이 끊겼을 때 먼저
 * 찾아뵐 근거가 되지만, 경제적 형편에 관한 정보라 크게 드러내지 않습니다 — 작은 점 하나로만
 * 표시하고, 무엇인지는 마우스를 올리면 보이게 합니다. 일반 이용자에게는 아무것도 붙지
 * 않습니다(대다수라, 붙이면 화면만 어지럽습니다).
 */
export function MealTierMark({ resident }: { resident: Resident }) {
  if (!resident || resident.mealTier === "일반") return null;
  const color = resident.mealTier === "무료급식" ? "bg-rose-500" : "bg-amber-500";
  return (
    <span
      className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${color}`}
      title={resident.mealTier === "무료급식" ? "무료급식 (기초수급 등)" : "감면 (차상위 등)"}
      aria-label={resident.mealTier}
    />
  );
}
