export type Cleanup = () => Promise<void> | void;

export class ShutdownManager {
  readonly #cleanups: Cleanup[] = [];
  #shutdownPromise: Promise<void> | undefined;

  register(cleanup: Cleanup): void {
    this.#cleanups.push(cleanup);
  }

  shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#runCleanups();
    return this.#shutdownPromise;
  }

  async #runCleanups(): Promise<void> {
    for (const cleanup of [...this.#cleanups].reverse()) {
      await cleanup();
    }
  }
}
