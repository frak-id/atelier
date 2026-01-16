import { mkdir } from "node:fs/promises";
import envPaths from "env-paths";

const APP_NAME = "frak-sandbox";

const paths = envPaths(APP_NAME, { suffix: "" });

// Allow explicit data directory override for production deployments
const dataDir = process.env.DATA_DIR ?? paths.data;

export const appPaths = {
  data: dataDir,
  config: process.env.DATA_DIR ? dataDir : paths.config,
  cache: process.env.DATA_DIR ? dataDir : paths.cache,
  log: process.env.DATA_DIR ? `${dataDir}/logs` : paths.log,
  temp: paths.temp,

  get database() {
    return `${dataDir}/manager.db`;
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
