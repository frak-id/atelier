import { Elysia } from "elysia";
import { userService } from "../container.ts";
import { UserListResponseSchema } from "../schemas/index.ts";
import { authPlugin } from "../shared/lib/auth.ts";

export const userRoutes = new Elysia({ prefix: "/users" })
  .use(authPlugin)
  // Security: strip per-user GitHub tokens — this directory is dashboard-wide.
  .get(
    "/",
    () =>
      userService
        .getAll()
        .map(({ githubAccessToken: _token, ...user }) => user),
    {
      response: UserListResponseSchema,
    },
  );
