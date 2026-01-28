import { DEFAULTS } from "@frak-sandbox/shared/constants";
import { nanoid } from "nanoid";
import type { CreateSandboxBody, Sandbox } from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("queue");

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

type JobStatus = "queued" | "running" | "completed" | "failed";

interface SpawnJob {
  id: string;
  options: CreateSandboxBody;
  status: JobStatus;
  result?: Sandbox;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
}

interface QueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  maxConcurrent: number;
}

type SpawnHandler = (options: CreateSandboxBody) => Promise<Sandbox>;

class SpawnQueue {
  private jobs = new Map<string, SpawnJob>();
  private queue: string[] = [];
  private running = new Set<string>();
  private maxConcurrent: number;
  private spawnHandler: SpawnHandler | null = null;

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  setHandler(handler: SpawnHandler): void {
    this.spawnHandler = handler;
  }

  async enqueue(options: CreateSandboxBody): Promise<SpawnJob> {
    const jobId = nanoid(8);
    const job: SpawnJob = {
      id: jobId,
      options,
      status: "queued",
      queuedAt: new Date().toISOString(),
      retryCount: 0,
    };

    this.jobs.set(jobId, job);
    this.queue.push(jobId);

    log.info({ jobId, options }, "Job queued");
    this.processQueue();

    return job;
  }

  async enqueueAndWait(
    options: CreateSandboxBody,
    timeoutMs = DEFAULTS.BOOT_TIMEOUT_MS,
  ): Promise<Sandbox> {
    const job = await this.enqueue(options);

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const checkCompletion = () => {
        const current = this.jobs.get(job.id);
        if (!current) {
          reject(new Error("Job disappeared from queue"));
          return;
        }

        if (current.status === "completed" && current.result) {
          resolve(current.result);
          return;
        }

        if (current.status === "failed") {
          reject(new Error(current.error || "Job failed"));
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          this.cancel(job.id);
          reject(new Error("Spawn timeout"));
          return;
        }

        setTimeout(checkCompletion, 100);
      };

      checkCompletion();
    });
  }

  private async processQueue(): Promise<void> {
    if (!this.spawnHandler) {
      log.warn("No spawn handler set, queue processing skipped");
      return;
    }

    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) continue;

      const job = this.jobs.get(jobId);
      if (!job || job.status !== "queued") continue;

      this.running.add(jobId);
      job.status = "running";
      job.startedAt = new Date().toISOString();

      log.info({ jobId }, "Job started");

      this.executeJob(job).finally(() => {
        this.running.delete(jobId);
        this.processQueue();
      });
    }
  }

  private async executeJob(job: SpawnJob): Promise<void> {
    let lastError: Error | null = null;

    while (job.retryCount <= MAX_RETRIES) {
      try {
        const result = await this.spawnHandler?.(job.options);
        job.status = "completed";
        job.result = result;
        job.completedAt = new Date().toISOString();
        log.info({ jobId: job.id, sandboxId: result?.id }, "Job completed");
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        job.retryCount++;

        if (job.retryCount <= MAX_RETRIES) {
          log.warn(
            {
              jobId: job.id,
              attempt: job.retryCount,
              error: lastError.message,
            },
            "Spawn failed, retrying",
          );
          await Bun.sleep(RETRY_DELAY_MS);
        }
      }
    }

    job.status = "failed";
    job.error = lastError?.message ?? "Unknown error";
    job.completedAt = new Date().toISOString();
    log.error(
      { jobId: job.id, error: job.error, totalAttempts: job.retryCount },
      "Job failed after retries",
    );
  }

  getJob(jobId: string): SpawnJob | undefined {
    return this.jobs.get(jobId);
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (job.status === "queued") {
      const queueIndex = this.queue.indexOf(jobId);
      if (queueIndex !== -1) {
        this.queue.splice(queueIndex, 1);
      }
      job.status = "failed";
      job.error = "Cancelled";
      job.completedAt = new Date().toISOString();
      log.info({ jobId }, "Job cancelled");
      return true;
    }

    return false;
  }

  getStats(): QueueStats {
    let queued = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;

    for (const job of this.jobs.values()) {
      switch (job.status) {
        case "queued":
          queued++;
          break;
        case "running":
          running++;
          break;
        case "completed":
          completed++;
          break;
        case "failed":
          failed++;
          break;
      }
    }

    return {
      queued,
      running,
      completed,
      failed,
      maxConcurrent: this.maxConcurrent,
    };
  }

  getQueuedJobs(): SpawnJob[] {
    return this.queue
      .map((id) => this.jobs.get(id))
      .filter((job): job is SpawnJob => job !== undefined);
  }

  getRunningJobs(): SpawnJob[] {
    return Array.from(this.running)
      .map((id) => this.jobs.get(id))
      .filter((job): job is SpawnJob => job !== undefined);
  }

  getRecentJobs(limit = 20): SpawnJob[] {
    return Array.from(this.jobs.values())
      .sort(
        (a, b) =>
          new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime(),
      )
      .slice(0, limit);
  }

  cleanup(maxAgeMs = 3600000): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status !== "queued" && job.status !== "running") {
        const completedAt = job.completedAt
          ? new Date(job.completedAt).getTime()
          : 0;
        if (completedAt < cutoff) {
          this.jobs.delete(jobId);
          removed++;
        }
      }
    }

    if (removed > 0) {
      log.info({ removed }, "Old jobs cleaned up");
    }

    return removed;
  }
}

export const QueueService = new SpawnQueue(
  config.defaults.MAX_SANDBOXES > 3 ? 3 : 2,
);
