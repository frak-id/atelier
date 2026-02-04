import { Elysia } from "elysia";
import { sandboxService } from "../../container";
import { NotFoundError } from "../../shared/errors";

export const sandboxIdGuard = new Elysia({ name: "sandbox-id-guard" })
  .resolve(({ params }) => {
    const { id } = params as { id: string };
    const sandbox = sandboxService.getById(id);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", id);
    }
    return { sandbox };
  })
  .as("scoped");
