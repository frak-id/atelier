import { $ } from "bun";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export async function exec(
  command: string,
  options: { quiet?: boolean; throws?: boolean } = {}
): Promise<ExecResult> {
  const { throws = true } = options;

  try {
    const result = await $`sh -c ${command}`.quiet();
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode,
      success: result.exitCode === 0,
    };
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer; exitCode?: number };
    const result: ExecResult = {
      stdout: err.stdout?.toString().trim() ?? "",
      stderr: err.stderr?.toString().trim() ?? "",
      exitCode: err.exitCode ?? 1,
      success: false,
    };

    if (throws) {
      throw new Error(`Command failed: ${command}\n${result.stderr}`);
    }

    return result;
  }
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await exec(`command -v ${command}`, { throws: false });
  return result.success;
}

export async function fileExists(path: string): Promise<boolean> {
  const result = await exec(`test -f ${path}`, { throws: false });
  return result.success;
}

export async function dirExists(path: string): Promise<boolean> {
  const result = await exec(`test -d ${path}`, { throws: false });
  return result.success;
}

export async function readFile(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

export async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}
