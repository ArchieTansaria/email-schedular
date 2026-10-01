import { extractEmailCandidates } from '@reachinbox/shared/leads';

export function extractLeadCandidates(contents: string): string[] {
  return extractEmailCandidates(contents);
}
