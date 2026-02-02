import type { ManagerEvent } from "../../schemas/events.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

export type { ManagerEvent };
export type {
  ConfigEvent,
  SandboxEvent,
  TaskEvent,
  WorkspaceEvent,
} from "../../schemas/events.ts";

const log = createChildLogger("event-bus");

/* -------------------------------------------------------------------------- */
/*                                  EventBus                                  */
/* -------------------------------------------------------------------------- */

type Listener = (event: ManagerEvent) => void;

class EventBus {
  private listeners = new Set<Listener>();

  emit(event: ManagerEvent): void {
    log.debug({ type: event.type }, "Event emitted");
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        log.error({ type: event.type, error }, "Event listener threw an error");
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    log.debug({ listenerCount: this.listeners.size }, "Listener subscribed");

    return () => {
      this.listeners.delete(listener);
      log.debug(
        { listenerCount: this.listeners.size },
        "Listener unsubscribed",
      );
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

export const eventBus = new EventBus();
