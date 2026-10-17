import { z } from 'zod';

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const campaignAttachmentSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (value) =>
        ![...value].some(
          (char) =>
            char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\',
        ),
      'Invalid attachment filename',
    ),
  contentType: z
    .string()
    .max(127)
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
  contentBase64: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((value) => value.length % 4 === 0, 'Invalid base64 content'),
});

export const campaignAttachmentsSchema = z
  .array(campaignAttachmentSchema)
  .max(MAX_ATTACHMENTS)
  .default([])
  .refine(
    (items) => items.reduce((size, item) => size + attachmentSize(item), 0) <= MAX_ATTACHMENT_BYTES,
    'Attachments must total at most 5 MB',
  );

export type CampaignAttachment = z.infer<typeof campaignAttachmentSchema>;

export function attachmentSize(item: CampaignAttachment): number {
  return (
    (item.contentBase64.length * 3) / 4 -
    (item.contentBase64.endsWith('==') ? 2 : item.contentBase64.endsWith('=') ? 1 : 0)
  );
}
