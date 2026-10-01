import { describe, expect, it } from 'vitest';
import { resolveSubmissionAttempt } from './idempotency.js';
import { parseLeadFile } from './leads.js';

describe('compose frontend logic', () => {
  it('parses and deduplicates a lead file while retaining the original', async () => {
    const file = {
      name: 'leads.csv',
      size: 60,
      text: async () => 'email\nAlice@Example.com\nalice@example.com\nbob@example.com',
    } as File;
    const result = await parseLeadFile(file);
    expect(result.file).toBe(file);
    expect(result.recipients).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('rejects unsupported, empty, and oversized lead files', async () => {
    await expect(
      parseLeadFile({ name: 'leads.pdf', size: 1, text: async () => 'a@example.com' } as File),
    ).rejects.toThrow('CSV or TXT');
    await expect(
      parseLeadFile({ name: 'leads.txt', size: 1, text: async () => 'none' } as File),
    ).rejects.toThrow('No valid');
    await expect(
      parseLeadFile({ name: 'leads.csv', size: 5 * 1024 * 1024 + 1, text: async () => '' } as File),
    ).rejects.toThrow('5 MB');
  });

  it('reuses a key for unchanged retries and rotates after semantic edits', () => {
    let sequence = 0;
    const generate = () => `key-${++sequence}`;
    const first = resolveSubmissionAttempt(null, 'payload-a', generate);
    const retry = resolveSubmissionAttempt(first, 'payload-a', generate);
    const edited = resolveSubmissionAttempt(retry, 'payload-b', generate);
    expect(retry.key).toBe(first.key);
    expect(edited.key).not.toBe(first.key);
  });
});
