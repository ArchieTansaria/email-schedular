import { describe, expect, it } from 'vitest';

import { SchedulingValidationError } from './errors.js';
import {
  validateScheduleCampaignInput,
  type ScheduleCampaignInput,
  type SchedulingLimits,
} from './validation.js';

const limits: SchedulingLimits = {
  MIN_SEND_DELAY_MS: 2_000,
  MAX_EMAILS_PER_HOUR_PER_SENDER: 200,
};

const validInput: ScheduleCampaignInput = {
  userId: '5c4ad7c7-0345-4be8-af49-b8a68598407f',
  senderId: 'a3bb189e-8bf9-4d64-9f89-cbabd3a75135',
  subject: '  Test subject  ',
  body: '  Test body  ',
  startAt: new Date('2030-01-01T10:00:00.000Z'),
  delayMs: 2_000,
  hourlyLimit: 200,
  idempotencyKey: '  request-1  ',
  recipients: [' Alice@Example.com ', 'alice@example.com', 'bob@example.com'],
};

describe('validateScheduleCampaignInput', () => {
  it('normalizes validated text and recipients', () => {
    expect(validateScheduleCampaignInput(validInput, limits)).toMatchObject({
      subject: 'Test subject',
      body: 'Test body',
      idempotencyKey: 'request-1',
      recipients: ['alice@example.com', 'bob@example.com'],
    });
  });

  it.each([
    ['subject', ''],
    ['body', '   '],
    ['idempotencyKey', ''],
    ['recipients', []],
    ['startAt', new Date(Number.NaN)],
  ] as const)('rejects invalid %s', (field, value) => {
    expect(() => validateScheduleCampaignInput({ ...validInput, [field]: value }, limits)).toThrow(
      SchedulingValidationError,
    );
  });

  it('enforces configured delay and hourly platform limits', () => {
    expect(() => validateScheduleCampaignInput({ ...validInput, delayMs: 1_999 }, limits)).toThrow(
      /delayMs must be at least 2000/,
    );
    expect(() =>
      validateScheduleCampaignInput({ ...validInput, hourlyLimit: 201 }, limits),
    ).toThrow(/hourlyLimit must be at most 200/);
    expect(() => validateScheduleCampaignInput({ ...validInput, hourlyLimit: 0 }, limits)).toThrow(
      SchedulingValidationError,
    );
  });

  it('rejects input that normalizes to no recipients', () => {
    expect(() =>
      validateScheduleCampaignInput({ ...validInput, recipients: ['', '  '] }, limits),
    ).toThrow(/at least one email/);
  });

  it('rejects campaigns above the assignment-scale safety limit', () => {
    const recipients = Array.from({ length: 10_001 }, (_, index) => `lead-${index}@example.test`);

    expect(() => validateScheduleCampaignInput({ ...validInput, recipients }, limits)).toThrow(
      /at most 10000 normalized addresses/,
    );
  });

  it('applies the assignment-scale limit after normalization and deduplication', () => {
    const recipients = Array.from({ length: 10_001 }, () => 'Alice@Example.com');

    expect(validateScheduleCampaignInput({ ...validInput, recipients }, limits).recipients).toEqual(
      ['alice@example.com'],
    );
  });
});
