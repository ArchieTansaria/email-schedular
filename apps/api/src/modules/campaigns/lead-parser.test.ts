import { describe, expect, it } from 'vitest';

import { extractLeadCandidates } from './lead-parser.js';

describe('extractLeadCandidates', () => {
  it('extracts newline-separated TXT leads and trims surrounding content', () => {
    expect(extractLeadCandidates(' Alice <alice@example.com>\n\nbob@example.com ')).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
  });

  it('extracts comma-separated CSV leads while ignoring a header', () => {
    expect(
      extractLeadCandidates('name,email\nAlice,Alice@Example.com\nBob,bob@example.com'),
    ).toEqual(['Alice@Example.com', 'bob@example.com']);
  });

  it('leaves casing and duplicates for the canonical recipient normalizer', () => {
    expect(extractLeadCandidates('Alice@Example.com, alice@example.com')).toEqual([
      'Alice@Example.com',
      'alice@example.com',
    ]);
  });

  it.each(['', 'email\nnot-an-address', 'plain invalid text'])(
    'returns no candidates for invalid or empty text: %j',
    (contents) => {
      expect(extractLeadCandidates(contents)).toEqual([]);
    },
  );
});
