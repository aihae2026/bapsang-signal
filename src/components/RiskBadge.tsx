import { Badge } from "@/components/ui/badge";
import { RISK_BADGE_STYLES, RISK_LABELS, type RiskLevel } from "@/lib/attendance-engine";

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    // 등급 이름이 좁은 칸에서 두 줄로 잘려 내려갔습니다(「긴급확 / 인」). 줄바꿈을 막습니다 —
    // 네 글자짜리 등급 이름이 세 글자에서 끊기면 무슨 말인지 알아보는 데 시간이 걸립니다.
    <Badge variant="outline" className={`whitespace-nowrap ${RISK_BADGE_STYLES[level]}`}>
      {RISK_LABELS[level]}
    </Badge>
  );
}
