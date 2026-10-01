import { describe, expect, it } from 'vitest';
import { extractEmailCandidates, uniqueNormalizedEmailCandidates } from './leads.js';

describe('portable lead parsing', () => {
  it('extracts common addresses and normalizes duplicates in order', () => {
    const input = 'email\nAlice <Alice@Example.com>, bob@example.com\nalice@example.com';
    expect(extractEmailCandidates(input)).toEqual([
      'Alice@Example.com',
      'bob@example.com',
      'alice@example.com',
    ]);
    expect(uniqueNormalizedEmailCandidates(input)).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
  });

  it('returns an empty list for content without addresses', () => {
    expect(uniqueNormalizedEmailCandidates('email\nnot an address')).toEqual([]);
  });
});
