import { nanoid } from "nanoid";
import type { SlackThread } from "../../schemas/index.ts";
import { NotFoundError, ValidationError } from "../../shared/errors.ts";
import type { SlackThreadRepository } from "./slack-thread.repository.ts";

export class SlackThreadService {
  constructor(private readonly repository: SlackThreadRepository) {}

  getAll(): SlackThread[] {
    return this.repository.getAll();
  }

  getByWorkspaceId(workspaceId: string): SlackThread[] {
    return this.repository.getByWorkspaceId(workspaceId);
  }

  getById(id: string): SlackThread | undefined {
    return this.repository.getById(id);
  }

  getByIdOrThrow(id: string): SlackThread {
    const thread = this.repository.getById(id);
    if (!thread) throw new NotFoundError("SlackThread", id);
    return thread;
  }

  getByThreadKey(channelId: string, threadTs: string): SlackThread | undefined {
    return this.repository.getByThreadKey(channelId, threadTs);
  }

  getActive(): SlackThread[] {
    return this.repository.getActive();
  }

  countActiveByWorkspaceId(workspaceId: string): number {
    return this.repository.countActiveByWorkspaceId(workspaceId);
  }

  create(body: {
    workspaceId: string;
    channelId: string;
    threadTs: string;
    userId: string;
    userName?: string;
    initialMessage: string;
  }): SlackThread {
    const now = new Date().toISOString();

    const thread: SlackThread = {
      id: `slk_${nanoid(12)}`,
      workspaceId: body.workspaceId,
      channelId: body.channelId,
      threadTs: body.threadTs,
      userId: body.userId,
      userName: body.userName,
      initialMessage: body.initialMessage,
      status: "pending",
      data: {},
      createdAt: now,
      updatedAt: now,
    };

    return this.repository.create(thread);
  }

  attachSandbox(
    id: string,
    sandboxId: string,
    branchName?: string,
  ): SlackThread {
    const thread = this.getByIdOrThrow(id);

    if (thread.status !== "spawning") {
      throw new ValidationError(
        "Thread must be in spawning status to attach sandbox",
      );
    }

    return this.repository.update(id, {
      sandboxId,
      ...(branchName && { branchName }),
    });
  }

  attachSession(id: string, sessionId: string): SlackThread {
    return this.repository.update(id, { sessionId });
  }

  markSpawning(id: string): SlackThread {
    return this.repository.updateStatus(id, "spawning");
  }

  markActive(id: string): SlackThread {
    return this.repository.updateStatus(id, "active");
  }

  markEnded(id: string): SlackThread {
    return this.repository.updateStatus(id, "ended");
  }

  markError(id: string, error: string): SlackThread {
    this.repository.updateStatus(id, "error");
    return this.repository.updateData(id, { error });
  }

  delete(id: string): void {
    this.repository.delete(id);
  }
}
