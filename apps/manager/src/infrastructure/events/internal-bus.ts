import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("internal-bus");

type InternalEvent =
  | { type: "sandbox.poll-services"; sandboxId: string }
  | { type: "sandbox.poll-git"; sandboxId: string }
  | { type: "sandbox.poll-all"; sandboxId: string };

type Listener = (event: InternalEvent) => void;

class InternalBus {
  private listeners = new Set<Listener>();

  emit(event: InternalEvent): void {
    log.debug({ type: event.type }, "Internal event");
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        log.error({ type: event.type, error: e }, "Internal listener error");
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export type { InternalEvent };
export const internalBus = new InternalBus();
