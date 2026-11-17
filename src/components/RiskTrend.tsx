import { getRiskTrend, RISK_LABELS, type Resident, type RiskLevel } from "@/lib/attendance-engine";

// 색은 등급 배지(RISK_BADGE_STYLES)와 같은 계열로 맞춥니다.
//
// 아래 주석에 적힌 사고가 색에서도 똑같이 났습니다 — 배지는 「관심」을 파랑으로 그리는데
// 이 점만 노랑이었습니다. 같은 화면에서 같은 어르신의 등급이 파란 배지와 노란 점으로
// 동시에 보였습니다. 색이 다르면 다른 뜻으로 읽힙니다.
const DOT: Record<RiskLevel, string> = {
  crisis: "bg-red-600",
  caution: "bg-orange-400",
  concern: "bg-blue-400",
  normal: "bg-emerald-500",
  unknown: "bg-stone-300",
};

// 라벨은 RISK_LABELS 한 곳에서만 가져옵니다.
// 여기 표를 따로 두었더니 등급 이름을 바꿀 때 이 파일만 옛 이름으로 남았고,
// normal 도 「정상」이 아니라 「양호」라고 적혀 있었습니다 — 화면읽기 프로그램이
// 읽어주는 문장까지 다른 말을 했습니다.
const LABEL = RISK_LABELS;

/**
 * 최근 3개월 등급을 점 세 개로 보여줍니다.
 *
 * 지금 "위기"라는 것만으로는 무엇을 해야 할지 정할 수 없습니다. 석 달 내내 위기였다면 지금까지
 * 한 방식이 안 듣고 있다는 뜻이고, 지난달까지 양호했다면 이번 달에 무슨 일이 생긴 것입니다.
 * 같은 "위기"라도 찾아가서 할 말이 다릅니다.
 *
 * 점만 찍고 마는 대신 달 이름을 함께 적었습니다 — 색만으로는 어느 쪽이 최근인지 알 수 없고,
 * 색을 구분하기 어려우신 분도 계십니다.
 */
export function RiskTrend({ resident, className }: { resident: Resident; className?: string }) {
  if (!resident) return null;
  const trend = getRiskTrend(resident);
  if (trend.length === 0) return null;

  return (
    <span
      className={`inline-flex items-center gap-1 ${className ?? ""}`}
      title={trend.map((t) => `${t.month} ${LABEL[t.level]} ${t.rate}%`).join(" → ")}
    >
      {trend.map((t, i) => (
        <span key={t.month} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-[10px] text-muted-foreground">›</span>}
          <span className="inline-flex items-center gap-0.5">
            <span className={`h-2 w-2 rounded-full ${DOT[t.level]}`} aria-hidden />
            <span className="text-[10px] tabular-nums text-muted-foreground">{t.month}</span>
          </span>
        </span>
      ))}
      <span className="sr-only">
        최근 3개월 추이: {trend.map((t) => `${t.month} ${LABEL[t.level]}`).join(", ")}
      </span>
    </span>
  );
}
