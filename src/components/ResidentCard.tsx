import { ResidentName, residentSubtitle } from "@/components/ResidentName";
import { Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { RiskBadge } from "@/components/RiskBadge";
import {
  RISK_BAR_COLORS,
  getCurrentRisk,
  getRecentAttendance,
  type Resident,
  type RiskLevel,
} from "@/lib/attendance-engine";

interface ResidentCardProps {
  resident: Resident;
  riskLevel?: RiskLevel;
  rate?: number;
  presentDays?: number;
  totalDays?: number;
  consecutiveAbsence?: number;
  lastAttendanceDate?: string | null;
  variant?: "compact" | "detailed";
}

export function ResidentCard({
  resident,
  riskLevel,
  rate,
  presentDays,
  totalDays,
  consecutiveAbsence,
  lastAttendanceDate,
  variant = "compact",
}: ResidentCardProps) {
  const fallback = getCurrentRisk(resident);
  const level = riskLevel ?? fallback.level;
  const displayRate = rate ?? fallback.rate;

  return (
    <Link
      to="/resident/$id"
      params={{ id: resident.id }}
      className="block transition-transform hover:-translate-y-0.5"
    >
      <Card className="p-4 hover:shadow-md">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">
              <ResidentName resident={resident} />
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{residentSubtitle(resident)}</div>
          </div>
          <RiskBadge level={level} />
        </div>

        {variant === "detailed" ? (
          <div className="mt-3 space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  이번 기간 출석률 {presentDays ?? 0}/{totalDays ?? 0}일
                </span>
                <span className="font-semibold text-foreground">{displayRate}%</span>
              </div>
              <div className="h-2 w-full rounded bg-stone-100">
                <div
                  className={`h-2 rounded ${RISK_BAR_COLORS[level]}`}
                  style={{ width: `${Math.min(100, displayRate)}%` }}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {!!consecutiveAbsence && consecutiveAbsence > 0 && (
                <span className="font-semibold text-red-600">연속결석 {consecutiveAbsence}일</span>
              )}
              <span>최근 출석일 {lastAttendanceDate ?? "기록 없음"}</span>
              <span>{resident.phone}</span>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <div className="mb-1 text-xs text-muted-foreground">최근 7일 출석</div>
            <div className="flex gap-1">
              {getRecentAttendance(resident, 7).map((present, i) => (
                <div
                  key={i}
                  className={`h-6 flex-1 rounded ${present ? "bg-emerald-400" : "bg-red-300"}`}
                  title={present ? "출석" : "결석"}
                />
              ))}
            </div>
          </div>
        )}
      </Card>
    </Link>
  );
}
