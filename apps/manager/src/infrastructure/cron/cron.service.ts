import { Cron } from "croner";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("cron");

export interface CronJobConfig {
  name: string;
  pattern: string;
  handler: () => void | Promise<void>;
}

export interface CronJobInfo {
  name: string;
  pattern: string;
  running: boolean;
  lastRun: string | null;
  nextRun: string | null;
}

interface RegisteredJob {
  cron: Cron;
  name: string;
  pattern: string;
  lastRun: Date | null;
}

class CronRegistry {
  private jobs = new Map<string, RegisteredJob>();

  add(key: string, config: CronJobConfig): void {
    const job: RegisteredJob = {
      cron: new Cron(config.pattern, async () => {
        job.lastRun = new Date();
        log.info({ key, name: config.name }, "Cron triggered");
        try {
          await config.handler();
        } catch (error) {
          log.error({ key, error }, "Cron failed");
        }
      }),
      name: config.name,
      pattern: config.pattern,
      lastRun: null,
    };
    this.jobs.set(key, job);
    log.info(
      { key, name: config.name, pattern: config.pattern },
      "Cron registered",
    );
  }

  get(key: string): Cron | undefined {
    return this.jobs.get(key)?.cron;
  }

  getStatus(): Record<string, CronJobInfo> {
    const result: Record<string, CronJobInfo> = {};
    for (const [key, job] of this.jobs) {
      result[key] = {
        name: job.name,
        pattern: job.pattern,
        running: job.cron.isRunning(),
        lastRun: job.lastRun?.toISOString() ?? null,
        nextRun: job.cron.nextRun()?.toISOString() ?? null,
      };
    }
    return result;
  }
}

export const CronService = new CronRegistry();
