import type { estypes } from '@elastic/elasticsearch';

export const EMAIL_SEARCH_INDEX = 'emails-v1' as const;

export const EMAIL_INDEX_MAPPING: estypes.MappingTypeMapping = {
  dynamic: 'strict',
  properties: {
    emailId: { type: 'keyword' },
    campaignId: { type: 'keyword' },
    userId: { type: 'keyword' },
    senderId: { type: 'keyword' },
    recipientEmail: {
      type: 'keyword',
      fields: { search: { type: 'text' } },
    },
    senderEmail: {
      type: 'keyword',
      fields: { search: { type: 'text' } },
    },
    subject: {
      type: 'text',
      fields: { raw: { type: 'keyword', ignore_above: 256 } },
    },
    body: { type: 'text' },
    status: { type: 'keyword' },
    originalScheduledAt: { type: 'date' },
    scheduledAt: { type: 'date' },
    sentAt: { type: 'date' },
    failureReason: { type: 'text' },
  },
};
