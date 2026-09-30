import { describe, expect, it, vi } from 'vitest';

import { ShutdownManager } from './lifecycle.js';

describe('ShutdownManager', () => {
  it('closes resources in reverse registration order and only once', async () => {
    const events: string[] = [];
    const firstCleanup = vi.fn(() => {
      events.push('first');
    });
    const secondCleanup = vi.fn(() => {
      events.push('second');
    });
    const manager = new ShutdownManager();

    manager.register(firstCleanup);
    manager.register(secondCleanup);

    await Promise.all([manager.shutdown(), manager.shutdown()]);

    expect(events).toEqual(['second', 'first']);
    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(secondCleanup).toHaveBeenCalledOnce();
  });
});
