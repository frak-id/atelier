import { Elysia, sse } from "elysia";
import { eventBus, type ManagerEvent } from "../infrastructure/events/index.ts";

import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("events-sse");

let eventId = 0;

export const eventsRoutes = new Elysia({ prefix: "/events" }).get(
  "/",
  async function* ({ request }) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const queue: ManagerEvent[] = [];
    let waiting: (() => void) | null = null;

    const unsubscribe = eventBus.subscribe((event) => {
      queue.push(event);
      if (waiting) {
        waiting();
        waiting = null;
      }
    });

    request.signal.addEventListener("abort", () => {
      unsubscribe();
      resolve();
    });

    log.info("SSE client connected");

    while (!request.signal.aborted) {
      if (queue.length === 0) {
        await Promise.race([
          new Promise<void>((r) => {
            waiting = r;
          }),
          promise,
        ]);
      }

      while (queue.length > 0) {
        const event = queue.shift();
        if (!event) continue;
        eventId++;
        yield sse({
          id: eventId,
          event: event.type,
          data: {
            type: event.type,
            properties: event.properties,
          },
        });
      }
    }

    log.info("SSE client disconnected");
  },
);
