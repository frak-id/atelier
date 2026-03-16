import { Elysia } from "elysia";
import { userService } from "../container.ts";
import { UserListResponseSchema } from "../schemas/index.ts";
import { authPlugin } from "../shared/lib/auth.ts";

export const userRoutes = new Elysia({ prefix: "/users" })
  .use(authPlugin)
  .get("/", () => userService.getAll(), {
    response: UserListResponseSchema,
  });
