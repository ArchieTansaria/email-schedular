export interface SchedulePlanInput {
  recipientCount: number;
  startAt: Date;
  now: Date;
  delayMs: number;
  hourlyLimit: number;
}

const hourMs = 60 * 60 * 1_000;

export function planSchedule({
  recipientCount,
  startAt,
  now,
  delayMs,
  hourlyLimit,
}: SchedulePlanInput): Date[] {
  if (recipientCount === 0) return [];

  const planned: Date[] = [];
  let nextTimestamp = Math.max(startAt.getTime(), now.getTime());
  let windowStart = startOfUtcHour(nextTimestamp);
  let plannedInWindow = 0;

  for (let index = 0; index < recipientCount; index += 1) {
    const candidateWindow = startOfUtcHour(nextTimestamp);
    if (candidateWindow !== windowStart) {
      windowStart = candidateWindow;
      plannedInWindow = 0;
    }

    if (plannedInWindow >= hourlyLimit) {
      nextTimestamp = windowStart + hourMs;
      windowStart = startOfUtcHour(nextTimestamp);
      plannedInWindow = 0;
    }

    planned.push(new Date(nextTimestamp));
    plannedInWindow += 1;
    nextTimestamp += delayMs;
  }

  return planned;
}

function startOfUtcHour(timestamp: number): number {
  return Math.floor(timestamp / hourMs) * hourMs;
}
