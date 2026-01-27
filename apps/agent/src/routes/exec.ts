import { Elysia, t } from "elysia";
import { DEFAULT_EXEC_TIMEOUT, MAX_EXEC_BUFFER } from "../constants";
import { ExecRequestSchema } from "../types";
import { exec } from "../utils/exec";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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

const BatchExecRequestSchema = t.Object({
  commands: t.Array(
    t.Object({
      id: t.String(),
      command: t.String(),
      timeout: t.Optional(t.Number({ minimum: 1000, maximum: 300000 })),
    }),
    { minItems: 1, maxItems: 20 },
  ),
});

export const execRoutes = new Elysia()
  .post("/exec", async ({ body }) => runCommand(body.command, body.timeout), {
    body: ExecRequestSchema,
  })
  .post(
    "/exec/batch",
    async ({ body }) => {
      const results = await Promise.all(
        body.commands.map(async (cmd) => ({
          id: cmd.id,
          ...(await runCommand(cmd.command, cmd.timeout)),
        })),
      );
      return { results };
    },
    { body: BatchExecRequestSchema },
  );
