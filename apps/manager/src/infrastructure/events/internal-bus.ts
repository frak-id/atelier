import { EventEmitter } from "node:events";

interface InternalEvents {
  "sandbox.poll-services": [sandboxId: string];
  "sandbox.poll-git": [sandboxId: string];
  "sandbox.poll-all": [sandboxId: string];
}

class InternalBus extends EventEmitter<InternalEvents> {}

export const internalBus = new InternalBus();
