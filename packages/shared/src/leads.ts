const EMAIL_CANDIDATE_PATTERN =
  /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/giu;

export function extractEmailCandidates(contents: string): string[] {
  return contents.match(EMAIL_CANDIDATE_PATTERN) ?? [];
}

export function uniqueNormalizedEmailCandidates(contents: string): string[] {
  return [...new Set(extractEmailCandidates(contents).map((email) => email.toLowerCase()))];
}
