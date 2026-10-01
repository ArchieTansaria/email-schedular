export class SchedulingValidationError extends Error {
  readonly code = 'SCHEDULING_VALIDATION_ERROR';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid campaign schedule:\n- ${issues.join('\n- ')}`);
    this.name = 'SchedulingValidationError';
    this.issues = issues;
  }
}

export class SenderUnavailableError extends Error {
  readonly code = 'SENDER_UNAVAILABLE';

  constructor() {
    super('Sender was not found, is not owned by the user, or is inactive');
    this.name = 'SenderUnavailableError';
  }
}

export class CampaignEnqueueError extends Error {
  readonly code = 'CAMPAIGN_ENQUEUE_FAILED';
  readonly campaignId: string;

  constructor(campaignId: string, cause: unknown) {
    super(`Campaign ${campaignId} was persisted but its jobs could not be enqueued`, { cause });
    this.name = 'CampaignEnqueueError';
    this.campaignId = campaignId;
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor() {
    super('Idempotency-Key is already associated with a different scheduling request');
    this.name = 'IdempotencyConflictError';
  }
}
