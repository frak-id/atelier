import { mkdir } from "node:fs/promises";
import envPaths from "env-paths";

const APP_NAME = "atelier";

const paths = envPaths(APP_NAME, { suffix: "" });

// Allow explicit data directory override for production deployments.
// Resolved lazily (getters) so a test that sets DATA_DIR in its own setup
// isn't defeated by another test file having imported this module first.
const dataDir = () => process.env.DATA_DIR ?? paths.data;

export const appPaths = {
  get data() {
    return dataDir();
  },
  get config() {
    return process.env.DATA_DIR ? dataDir() : paths.config;
  },
  get cache() {
    return process.env.DATA_DIR ? dataDir() : paths.cache;
  },
  get log() {
    return process.env.DATA_DIR ? `${dataDir()}/logs` : paths.log;
  },
  temp: paths.temp,

  get database() {
    return `${dataDir()}/server.db`;
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
