/**
 * 「밥상위의 신호」 상징 마크 — 밥 한 그릇을 가로지르는 맥박선.
 *
 * 전에는 lucide의 HeartPulse(하트 + 지그재그)를 썼습니다. 그 아이콘은 의료·응급 기호라
 * 앱이 응급구조대처럼 읽혔습니다. 이 도구는 응급 출동이 아니라 매일의 밥상을 지켜보는
 * 일이므로, 기호도 밥그릇이어야 맞습니다.
 *
 * 형태는 기관에서 만든 로고 원본을 그대로 따랐습니다. 원본 이미지(1254×1254)를 픽셀 단위로
 * 재서 비율을 옮겼습니다 — 밥 무덤 44% · 그릇 44% · 굽 12%, 테두리는 높이의 44% 지점,
 * 신호선 밑줄은 70% 지점, 굽 폭은 전체 폭의 45%.
 *
 * ── 색을 둘로 나눈 이유 ────────────────────────────────────
 * 원본은 전부 빨강인데, 화면에서 크게 쓰면 빨강이 "위험"으로 읽힙니다. 그릇을 기관 색(올리브
 * 녹색)으로 두고 빨강을 신호선에만 남기면, 빨강이 위험이 아니라 **읽어야 할 신호**라는
 * 뜻을 갖습니다. 이 도구가 하는 일이 정확히 그것입니다.
 *
 * 그릇은 currentColor를 씁니다 — 밝은 배경에서는 text-primary, 어두운 패널에서는
 * text-lime-50 처럼 부르는 쪽에서 정하면 됩니다. 신호선은 안쪽 <g>가 색을 따로 잡습니다.
 */
export function BapsangMark({
  /**
   * 그리는 방식.
   *
   * `"image"`(기본)는 기관에서 만든 로고 원본(public/brand/bapsang-mark.png)을 그대로
   * 씁니다. 화면·회원가입·문서 어디에 나오든 같은 그림이어야 하니 이쪽이 기본입니다.
   *
   * `"svg"`는 아래 좌표로 직접 그립니다. 색을 currentColor 로 받기 때문에 **어두운
   * 배경**이나 **아주 옅게 깔아야 하는 배경 무늬**에서만 씁니다 — 원본은 검은 선이라
   * 짙은 바탕에서는 보이지 않습니다.
   */
  as = "image",
  className = "",
  /** 신호선 색. 어두운 배경에서는 더 밝은 빨강으로 바꿔 부르세요. */
  signalClassName = "text-red-600",
  /** 획 두께. 20px 이하로 쓸 때는 2.6 정도로 올리면 또렷합니다. */
  strokeWidth = 2.3,
}: {
  as?: "image" | "svg";
  className?: string;
  signalClassName?: string;
  strokeWidth?: number;
}) {
  const w = strokeWidth;
  // 밥알. 좌우 대칭으로 두면 눈처럼 보여 얼굴이 되므로 일부러 흩어놓았습니다.
  const grains: [number, number][] = [
    [15.4, 11.2],
    [23.6, 10.4],
    [12.9, 14.9],
    [20.0, 15.5],
    [26.9, 14.6],
  ];

  if (as === "image") {
    return (
      <img
        src="/brand/bapsang-mark.png"
        alt=""
        aria-hidden="true"
        // 부르는 쪽이 h-6 w-6 처럼 크기를 정해 주므로 그 안에 맞춥니다.
        className={`object-contain ${className}`}
        draggable={false}
      />
    );
  }

  return (
    <svg viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
      <g
        stroke="currentColor"
        strokeWidth={w}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        {/* 밥 무덤 */}
        <path d="M7.1 18.3A12.9 12.85 0 0 1 32.9 18.3" />
        {grains.map(([cx, cy]) => (
          <path
            key={`${cx}-${cy}`}
            d={`M${cx - 1.05} ${cy + 0.5}Q${cx} ${cy - 0.68} ${cx + 1.05} ${cy + 0.5}`}
            strokeWidth={w - 0.7}
          />
        ))}
        {/* 그릇 테두리 */}
        <path d="M4 18.3h32" />
        {/* 그릇 몸통 — 옆은 둥글고 바닥은 평평하게. 바닥이 뾰족하면 굽이 따로 노는
            접시처럼 보입니다. */}
        <path d="M4 18.3c0 8.2 4.8 13.3 10.5 13.3h11c5.7 0 10.5-5.1 10.5-13.3" />
        {/* 굽 */}
        <path d="M15.6 31.6v2.2c0 .9.6 1.4 1.5 1.4h5.8c.9 0 1.5-.5 1.5-1.4v-2.2" />
      </g>

      {/* 신호선 — 이 마크에서 유일하게 빨간 부분입니다. */}
      <g className={signalClassName}>
        <path
          d="M8 26.1h9.6l1.4-3.9 1.9 8.8 1.5-4.9H32"
          stroke="currentColor"
          strokeWidth={w}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </g>
    </svg>
  );
}
