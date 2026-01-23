import {
  createOpencodeClient,
  type Event,
  type EventSessionIdle,
  type EventSessionStatus,
} from "@opencode-ai/sdk/v2";
import type { TaskService } from "../modules/task/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("session-monitor");

interface MonitoredSession {
  taskId: string;
  sessionId: string;
  opencodeUrl: string;
  abortController: AbortController;
}

export class SessionMonitor {
  private readonly sessions = new Map<string, MonitoredSession>();

  constructor(private readonly taskService: TaskService) {}

  startMonitoring(taskId: string, sessionId: string, ipAddress: string): void {
    const key = `${taskId}:${sessionId}`;

    if (this.sessions.has(key)) {
      log.warn({ taskId, sessionId }, "Session already being monitored");
      return;
    }

    const opencodeUrl = `http://${ipAddress}:3000`;
    const abortController = new AbortController();

    const session: MonitoredSession = {
      taskId,
      sessionId,
      opencodeUrl,
      abortController,
    };

    this.sessions.set(key, session);

    log.info(
      { taskId, sessionId, ip: ipAddress },
      "Started monitoring session",
    );

    this.subscribeToEvents(session).catch((error) => {
      log.error(
        { taskId, sessionId, error: String(error) },
        "Session monitor subscription failed",
      );
      this.sessions.delete(key);
    });
  }

  stopMonitoring(taskId: string, sessionId: string): void {
    const key = `${taskId}:${sessionId}`;
    const session = this.sessions.get(key);

    if (session) {
      session.abortController.abort();
      this.sessions.delete(key);
      log.info({ taskId, sessionId }, "Stopped monitoring session");
    }
  }

  stopMonitoringTask(taskId: string): void {
    for (const [key, session] of this.sessions.entries()) {
      if (session.taskId === taskId) {
        session.abortController.abort();
        this.sessions.delete(key);
        log.info(
          { taskId, sessionId: session.sessionId },
          "Stopped monitoring session",
        );
      }
    }
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();
    log.info("Stopped all session monitoring");
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  private async subscribeToEvents(session: MonitoredSession): Promise<void> {
    const { taskId, sessionId, opencodeUrl, abortController } = session;

    const client = createOpencodeClient({ baseUrl: opencodeUrl });

    const result = await client.event.subscribe(undefined, {
      signal: abortController.signal,
      sseMaxRetryAttempts: 10,
      sseDefaultRetryDelay: 5000,
      sseMaxRetryDelay: 30000,
    });

    try {
      for await (const event of result.stream) {
        if (abortController.signal.aborted) {
          break;
        }

        this.handleEvent(taskId, sessionId, event as Event);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      throw error;
    } finally {
      const key = `${taskId}:${sessionId}`;
      this.sessions.delete(key);
    }
  }

  private handleEvent(taskId: string, sessionId: string, event: Event): void {
    if (event.type === "session.idle") {
      const idleEvent = event as EventSessionIdle;
      if (idleEvent.properties.sessionID === sessionId) {
        log.info(
          { taskId, sessionId },
          "Session became idle, moving to review",
        );
        this.transitionToReview(taskId);
      }
      return;
    }

    if (event.type === "session.status") {
      const statusEvent = event as EventSessionStatus;
      if (statusEvent.properties.sessionID === sessionId) {
        const status = statusEvent.properties.status;
        log.debug(
          { taskId, sessionId, status: status.type },
          "Session status changed",
        );

        if (status.type === "idle") {
          log.info(
            { taskId, sessionId },
            "Session status is idle, moving to review",
          );
          this.transitionToReview(taskId);
        }
      }
    }
  }

  private transitionToReview(taskId: string): void {
    try {
      const task = this.taskService.getById(taskId);
      if (!task) {
        log.warn({ taskId }, "Task not found for transition");
        return;
      }

      if (task.status !== "in_progress") {
        log.debug(
          { taskId, status: task.status },
          "Task not in_progress, skipping transition",
        );
        return;
      }

      this.taskService.moveToReview(taskId);
      log.info(
        { taskId, title: task.title },
        "Task auto-transitioned to pending_review",
      );

      this.stopMonitoringTask(taskId);
    } catch (error) {
      log.error(
        { taskId, error: String(error) },
        "Failed to transition task to review",
      );
    }
  }
}
