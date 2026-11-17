import { Link } from "@tanstack/react-router";
/**
 * 모든 화면 아래에 붙는 기관 표시.
 *
 * 내비게이션에는 자리가 좁아 심볼만 넣었기 때문에, 기관 전체 로고와 연락처는 여기에 둡니다.
 * 대시보드 헤더에 같이 넣으면 "오늘 무엇을 봐야 하는가"를 가리게 되어 일부러 아래로 내렸습니다.
 */
export function BrandFooter() {
  return (
    <footer className="border-t bg-white">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-7 sm:flex-row sm:items-center sm:justify-between">
        <img
          src="/brand/ccnoin-logo.png"
          alt="춘천남부노인복지관 · 사단법인 동부디아코니아"
          className="h-8 w-auto self-start sm:self-center"
          width={800}
          height={135}
        />
        <div className="text-xs leading-relaxed text-muted-foreground sm:text-right">
          <p>
            강원특별자치도 춘천시 방송길 86 · 033-241-5600
            {/* 개인정보 처리방침은 어느 화면에서든 한 번에 닿아야 합니다(개인정보보호법 제30조
                "정보주체가 쉽게 확인할 수 있도록"). 모든 화면 아래에 붙는 이 자리에 둡니다. */}
            <span className="mx-1.5 text-stone-300">·</span>
            <Link
              to="/privacy"
              className="font-medium text-foreground underline underline-offset-2"
            >
              개인정보 처리방침
            </Link>
          </p>
          {/* 기관 비전. 낱말 사이를 가운뎃점으로 끊어 구호가 아니라 나열로 읽히게 합니다. */}
          <p className="mt-1.5 font-medium text-foreground">
            진실한 섬김
            <span className="mx-1.5 font-normal text-stone-300">·</span>
            사회적 돌봄
            <span className="mx-1.5 font-normal text-stone-300">·</span>
            변화와 혁신
          </p>
          <p className="mt-0.5">디아코니아로 행복한 세상을 만들어갑니다.</p>
        </div>
      </div>
    </footer>
  );
}
