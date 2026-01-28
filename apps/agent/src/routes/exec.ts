import { DEFAULT_EXEC_TIMEOUT, MAX_EXEC_BUFFER } from "../constants.ts";
import type { ExecResult } from "../types.ts";
import { exec } from "../utils/exec.ts";

async function runCommand(
  command: string,
  timeout?: number,
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await exec(command, {
      timeout: timeout ?? DEFAULT_EXEC_TIMEOUT,
      maxBuffer: MAX_EXEC_BUFFER,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error: unknown) {
    const err = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      exitCode: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
    };
  }
}

export async function handleExec(request: Request): Promise<Response> {
  const body = await request.json();
  const result = await runCommand(body.command, body.timeout);
  return Response.json(result);
}

export async function handleExecBatch(request: Request): Promise<Response> {
  const body = await request.json();
  const results = await Promise.all(
    body.commands.map(
      async (cmd: { id: string; command: string; timeout?: number }) => ({
        id: cmd.id,
        ...(await runCommand(cmd.command, cmd.timeout)),
      }),
    ),
  );
  return Response.json({ results });
}
