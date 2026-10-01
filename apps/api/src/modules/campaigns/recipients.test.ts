import { describe, expect, it } from 'vitest';

import { SchedulingValidationError } from './errors.js';
import { normalizeRecipients } from './recipients.js';

describe('normalizeRecipients', () => {
  it('normalizes case and whitespace, removes empties, and preserves first occurrence order', () => {
    expect(
      normalizeRecipients([
        ' Alice@Example.com ',
        '',
        'alice@example.com',
        '  ',
        'BOB@example.com',
        'carol@example.com',
        'bob@example.com',
      ]),
    ).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
  });

  it('rejects implausible email addresses instead of silently dropping them', () => {
    expect(() => normalizeRecipients(['valid@example.com', 'not-an-email'])).toThrow(
      SchedulingValidationError,
    );
    expect(() => normalizeRecipients(['missing-domain@'])).toThrow(/missing-domain@/);
  });
});
