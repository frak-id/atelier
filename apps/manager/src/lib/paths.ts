import envPaths from "env-paths";
import { mkdir } from "node:fs/promises";

const APP_NAME = "frak-sandbox";

const paths = envPaths(APP_NAME, { suffix: "" });

export const appPaths = {
  data: paths.data,
  config: paths.config,
  cache: paths.cache,
  log: paths.log,
  temp: paths.temp,

  get database() {
    return `${paths.data}/manager.db`;
  },
};

export async function ensureAppDirs(): Promise<void> {
  await Promise.all([
    mkdir(appPaths.data, { recursive: true }),
    mkdir(appPaths.config, { recursive: true }),
    mkdir(appPaths.cache, { recursive: true }),
    mkdir(appPaths.log, { recursive: true }),
  ]);
}
