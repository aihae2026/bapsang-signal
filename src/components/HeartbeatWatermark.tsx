/**
 * 대시보드 배경에 깔리는 상징 표시 — 밥 한 그릇과, 그 위를 훑고 지나가는 신호선.
 *
 * 예전에는 하트를 깔았습니다. 이 도구가 응급구조처럼 읽히던 이유 중 하나였고, 무엇보다
 * 하는 일과 맞지 않았습니다. 이 도구가 보는 것은 심장이 아니라 밥상입니다.
 *
 * 그릇은 **기관 로고 원본 파일**을 그대로 깝니다(BapsangMark 와 같은 그림). 한동안 여기서
 * 좌표로 다시 그렸는데, 그러면 같은 화면에 서로 다른 두 그릇이 놓입니다 — 크게 깔리는
 * 쪽이 조금이라도 다르면 그게 더 눈에 띕니다.
 *
 * 신호선만 따로 SVG 로 남겨 둡니다. 배경에서는 그릇을 옅게 깔고 선만 또렷하게 움직여야
 * 하는데, 그건 불투명도·흐림을 서로 다르게 다뤄야 하는 일이라 한 장의 그림으로는 안 됩니다.
 *
 * 신호선은 stroke-dasharray/offset을 굴려 왼쪽에서 오른쪽으로 훑고 지나갑니다 — 모니터의
 * 선이 지나가는 모습입니다. 그릇은 흐릿하게 깔고 선만 또렷하게 두어, 배경이 글씨를
 * 방해하지 않으면서도 살아 있는 느낌이 나게 했습니다.
 *
 * 화면을 읽는 데 방해가 되면 안 되므로 aria-hidden + pointer-events-none 이고,
 * 동작 최소화를 켠 사용자에게는 애니메이션이 멈춥니다(styles.css의 미디어 쿼리).
 */
export function HeartbeatWatermark({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`pointer-events-none select-none ${className}`}>
      {/* 그릇 — 기관 로고 원본을 아주 옅게 깝니다.
          예전에는 여기서 좌표로 다시 그렸습니다. 아이콘(BapsangMark)은 기관 원본 파일을
          쓰는데 배경만 손으로 그린 그림이라, 같은 화면에 **서로 다른 두 그릇**이 있었습니다.
          크게 깔리는 쪽이 원본과 조금이라도 다르면 그게 더 눈에 띕니다.
          원본은 검은 선이라 그대로 깔면 진하니, 옅게 + 흐리게 해서 글씨를 방해하지 않게
          합니다. */}
      <img
        src="/brand/bapsang-mark.png"
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain opacity-[0.07] blur-[1.5px]"
      />
      {/* 신호선 — 여기만 또렷합니다.
          아이콘에서는 그릇 안(y≈130)을 가로지르지만, 대시보드에서는 그 높이가 요약 카드에
          덮여 아예 보이지 않았습니다. 그래서 배경용은 밥 무덤 위로 올려, 카드가 시작되기
          전의 머리말 공간을 지나가게 했습니다. 봉긋한 밥 위로 솟았다 내려오는 모양이라
          "밥상 위의 신호"라는 이름과도 맞습니다. */}
      <svg viewBox="0 0 200 200" fill="none" className="absolute inset-0 h-full w-full">
        <path
          d="M6 58h64l9-26 11 58 9-32h84"
          className="heartbeat-line stroke-red-600/55"
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
