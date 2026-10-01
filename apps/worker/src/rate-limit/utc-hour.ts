const HOUR_MS = 60 * 60 * 1_000;

export interface UtcHourWindow {
  id: string;
  startAt: Date;
  nextAt: Date;
}

export function getUtcHourWindow(now: Date): UtcHourWindow {
  const startMs = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const startAt = new Date(startMs);

  return {
    id: startAt.toISOString().slice(0, 13),
    startAt,
    nextAt: new Date(startMs + HOUR_MS),
  };
}
