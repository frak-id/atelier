import { $ } from "bun";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export async function exec(
  command: string,
  options: { throws?: boolean } = {},
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
    const err = error as {
      stdout?: Buffer;
      stderr?: Buffer;
      exitCode?: number;
    };
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

export async function execLive(command: string): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  return proc.exited;
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await exec(`command -v ${command}`, { throws: false });
  return result.success;
}

export async function isRoot(): Promise<boolean> {
  const result = await exec("id -u", { throws: false });
  return result.stdout === "0";
}

export async function getArch(): Promise<string> {
  const result = await exec("uname -m");
  return result.stdout;
}

export async function fileExists(path: string): Promise<boolean> {
  const result = await exec(`test -f ${path}`, { throws: false });
  return result.success;
}

export async function isValidElf(path: string): Promise<boolean> {
  try {
    const file = Bun.file(path);
    const buffer = await file.slice(0, 4).arrayBuffer();
    const magic = new Uint8Array(buffer);
    return (
      magic[0] === 0x7f &&
      magic[1] === 0x45 &&
      magic[2] === 0x4c &&
      magic[3] === 0x46
    );
  } catch {
    return false;
  }
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Bun.file(path).stat();
    return stat?.isDirectory?.() ?? false;
  } catch {
    return false;
  }
}
