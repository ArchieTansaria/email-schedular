import { uniqueNormalizedEmailCandidates } from '@reachinbox/shared/leads';

export const MAX_LEAD_FILE_BYTES = 5 * 1024 * 1024;

export interface ParsedLeadFile {
  file: File;
  recipients: string[];
}

export async function parseLeadFile(file: File): Promise<ParsedLeadFile> {
  const extension = file.name.toLowerCase().split('.').at(-1);
  if (extension !== 'csv' && extension !== 'txt') throw new Error('Choose a CSV or TXT file.');
  if (file.size > MAX_LEAD_FILE_BYTES) throw new Error('Lead file must not exceed 5 MB.');
  const recipients = uniqueNormalizedEmailCandidates(await file.text());
  if (recipients.length === 0) throw new Error('No valid email addresses were found.');
  if (recipients.length > 10_000)
    throw new Error('A campaign can contain at most 10,000 recipients.');
  return { file, recipients };
}
