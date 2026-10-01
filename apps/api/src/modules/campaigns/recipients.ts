import { SchedulingValidationError } from './errors.js';

const plausibleEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const maximumEmailLength = 320;

export function normalizeRecipients(values: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];

  for (const value of values) {
    const email = value.trim().toLowerCase();
    if (email === '') continue;

    if (email.length > maximumEmailLength || !plausibleEmailPattern.test(email)) {
      invalid.push(value);
      continue;
    }

    if (!seen.has(email)) {
      seen.add(email);
      normalized.push(email);
    }
  }

  if (invalid.length > 0) {
    throw new SchedulingValidationError(
      invalid.map((value) => `Invalid recipient email: ${JSON.stringify(value)}`),
    );
  }

  return normalized;
}
