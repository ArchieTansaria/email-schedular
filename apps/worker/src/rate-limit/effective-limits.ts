export interface EffectiveSendLimits {
  delayMs: number;
  hourlyLimit: number;
}

export function getEffectiveSendLimits(
  campaign: { delayMs: number; hourlyLimit: number },
  platform: { minSendDelayMs: number; maxEmailsPerHourPerSender: number },
): EffectiveSendLimits {
  return {
    delayMs: Math.max(campaign.delayMs, platform.minSendDelayMs),
    hourlyLimit: Math.min(campaign.hourlyLimit, platform.maxEmailsPerHourPerSender),
  };
}
