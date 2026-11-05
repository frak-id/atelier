/**
 * Per-sandbox operation lock: create/pause/resume/destroy/snapshot and the
 * live mutations on the same id serialize instead of racing (a double resume
 * booting two pods on one pod name, destroy sweeping resources out from under
 * an in-flight create, two `addProcess` losing each other's write, …).
 * Queued ops re-read the record once they acquire the lock, so status guards
 * see the previous op's outcome.
 */
export class OpLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** Whether an op holds (or waits for) the lock on `id` right now. */
  has(id: string): boolean {
    return this.tails.has(id);
  }

  /** Each op chains onto the tail of the previous one (fulfilled or
   * rejected — a failed pause must not poison a queued destroy). The entry
   * is dropped when the tail drains. */
  async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(id) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(id, tail);
    tail.finally(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return run;
  }
}
