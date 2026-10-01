export function senderRateCounterKey(senderId: string, hourWindow: string): string {
  return `email:rate:{${senderId}}:${hourWindow}`;
}

export function senderNextSendKey(senderId: string): string {
  return `email:next-send:{${senderId}}`;
}
