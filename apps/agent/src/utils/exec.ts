import { exec as execCallback, execSync } from "node:child_process";
import { promisify } from "node:util";

export const exec = promisify(execCallback);
export { execSync };
