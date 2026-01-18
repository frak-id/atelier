import { Elysia } from "elysia";
import { DEFAULT_EXEC_TIMEOUT, MAX_EXEC_BUFFER } from "../constants";
import { ExecRequestSchema } from "../types";
import { exec } from "../utils/exec";

export const execRoutes = new Elysia().post(
  "/exec",
  async ({ body }) => {
    try {
      const { stdout, stderr } = await exec(body.command, {
        timeout: body.timeout ?? DEFAULT_EXEC_TIMEOUT,
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
  },
  {
    body: ExecRequestSchema,
  },
);
