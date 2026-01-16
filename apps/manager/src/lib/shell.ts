import { mkdir, stat } from "node:fs/promises";
import { $ } from "bun";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/** @deprecated Use Bun's $ tagged template directly for new code */
export async function exec(
  command: string,
  options: { throws?: boolean } = {},
): Promise<ExecResult> {
  const { throws = true } = options;

  const result = await $`${{ raw: command }}`.quiet().nothrow();

  const execResult: ExecResult = {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
    success: result.exitCode === 0,
  };

  if (throws && !execResult.success) {
    throw new Error(`Command failed: ${command}\n${execResult.stderr}`);
  }

  return execResult;
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await $`command -v ${command}`.quiet().nothrow();
  return result.exitCode === 0;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function readFile(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return await file.text();
  } catch {
    return null;
  }
}

export async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
