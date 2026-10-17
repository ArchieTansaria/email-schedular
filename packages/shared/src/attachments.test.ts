import { describe, expect, it } from 'vitest';
import { attachmentSize, campaignAttachmentsSchema, MAX_ATTACHMENT_BYTES } from './attachments.js';

const attachment = { filename: 'notes.txt', contentType: 'text/plain', contentBase64: 'SGk=' };

describe('campaign attachments', () => {
  it('validates metadata and exact decoded lengths', () => {
    expect(attachmentSize(campaignAttachmentsSchema.parse([attachment])[0]!)).toBe(2);
    expect(campaignAttachmentsSchema.parse(undefined)).toEqual([]);
    expect(() =>
      campaignAttachmentsSchema.parse([{ ...attachment, filename: '../secret' }]),
    ).toThrow();
    expect(() =>
      campaignAttachmentsSchema.parse([{ ...attachment, filename: 'bad\r\nname' }]),
    ).toThrow();
    expect(() =>
      campaignAttachmentsSchema.parse([{ ...attachment, contentBase64: 'not base64!' }]),
    ).toThrow();
  });

  it('bounds count and aggregate decoded bytes', () => {
    expect(() =>
      campaignAttachmentsSchema.parse(Array.from({ length: 6 }, () => attachment)),
    ).toThrow();
    const large = {
      ...attachment,
      contentBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64'),
    };
    expect(() => campaignAttachmentsSchema.parse([large])).not.toThrow();
    expect(() => campaignAttachmentsSchema.parse([large, attachment])).toThrow(/5 MB/);
  });
});
