import type { NewsletterFrequency, Period } from "../domain/types.js";

export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function computeDefaultPeriod(frequency: NewsletterFrequency, now = new Date()): Period {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);

  if (frequency === "daily") {
    start.setUTCDate(end.getUTCDate());
  } else if (frequency === "weekly") {
    start.setUTCDate(end.getUTCDate() - 7);
  } else {
    start.setUTCDate(end.getUTCDate() - 30);
  }

  return {
    start: toDateOnly(start),
    end: toDateOnly(end)
  };
}

export function dayDistance(leftDateOnly: string, rightDateOnly: string): number {
  const left = new Date(`${leftDateOnly}T00:00:00.000Z`).getTime();
  const right = new Date(`${rightDateOnly}T00:00:00.000Z`).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return 0;
  }
  return Math.round((right - left) / 86_400_000);
}
