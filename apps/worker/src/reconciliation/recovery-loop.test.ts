import { afterEach, describe, expect, it, vi } from 'vitest';

import { startRecoveryLoop } from './recovery-loop.js';

afterEach(() => vi.useRealTimers());

describe('queue recovery polling', () => {
  it('does not overlap passes and waits for an active pass during shutdown', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const reconcile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = startRecoveryLoop({ reconcile, intervalMs: 100, logger: { error: vi.fn() } });

    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcile).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('keeps polling after an infrastructure error and cancels a pending timer', async () => {
    vi.useFakeTimers();
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error('Database unavailable'))
      .mockResolvedValue({});
    const logger = { error: vi.fn() };
    const stop = startRecoveryLoop({ reconcile, intervalMs: 100, logger });

    await vi.advanceTimersByTimeAsync(200);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledOnce();
    await stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
