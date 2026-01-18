import { t } from "elysia";

export const AuthModel = {
  callbackQuery: t.Object({
    code: t.String(),
    state: t.String(),
  }),

  statusResponse: t.Object({
    connected: t.Boolean(),
    user: t.Optional(
      t.Object({
        login: t.String(),
        avatarUrl: t.String(),
      }),
    ),
  }),

  logoutResponse: t.Object({
    success: t.Boolean(),
  }),

  errorResponse: t.Object({
    error: t.String(),
    message: t.String(),
  }),
};
