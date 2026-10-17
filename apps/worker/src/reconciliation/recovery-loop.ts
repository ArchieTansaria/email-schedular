interface RecoveryLoopOptions {
  reconcile: () => Promise<unknown>;
  intervalMs: number;
  logger: { error(bindings: Record<string, unknown>, message: string): void };
}

/** Recovery polling only; email due times remain in BullMQ delayed jobs. */
export function startRecoveryLoop({ reconcile, intervalMs, logger }: RecoveryLoopOptions) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  function schedule() {
    if (!stopped) timer = setTimeout(run, intervalMs);
  }

  function run() {
    running = (async () => {
      try {
        await reconcile();
      } catch (error) {
        logger.error({ error, operation: 'queue-recovery' }, 'Queue recovery failed; will retry');
      } finally {
        schedule();
      }
    })();
  }

  schedule();
  return async function stop() {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
