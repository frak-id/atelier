import { Elysia } from "elysia";
import { sshKeyService } from "../../container.ts";
import { SshPiperService } from "../../infrastructure/proxy/index.ts";
import {
  CreateSshKeyBodySchema,
  HasSshKeysResponseSchema,
  IdParamSchema,
  SshKeyListResponseSchema,
  SshKeySchema,
} from "../../schemas/index.ts";
import type { AuthUser } from "../../shared/lib/auth.ts";

function getUser(store: { user?: AuthUser }): AuthUser {
  if (!store.user) throw new Error("User not authenticated");
  return store.user;
}

export const sshKeyRoutes = new Elysia({ prefix: "/ssh-keys" })
  .get(
    "/",
    ({ store }) => {
      const user = getUser(store as { user?: AuthUser });
      return sshKeyService.listByUserId(user.id);
    },
    {
      response: SshKeyListResponseSchema,
    },
  )
  .get(
    "/has-keys",
    ({ store }) => {
      const user = getUser(store as { user?: AuthUser });
      return { hasKeys: sshKeyService.hasKeysForUser(user.id) };
    },
    {
      response: HasSshKeysResponseSchema,
    },
  )
  .post(
    "/",
    async ({ body, store }) => {
      const user = getUser(store as { user?: AuthUser });

      const sshKey = sshKeyService.create({
        userId: user.id,
        username: user.username,
        publicKey: body.publicKey,
        name: body.name,
        type: body.type,
        expiresAt: body.expiresAt,
      });

      const allKeys = sshKeyService.getAllValidKeys().map((k) => k.publicKey);
      await SshPiperService.updateAuthorizedKeys(allKeys);

      return sshKey;
    },
    {
      body: CreateSshKeyBodySchema,
      response: SshKeySchema,
    },
  )
  .delete(
    "/:id",
    async ({ params, store, set }) => {
      const user = getUser(store as { user?: AuthUser });
      try {
        sshKeyService.delete(params.id, user.id);

        const allKeys = sshKeyService.getAllValidKeys().map((k) => k.publicKey);
        await SshPiperService.updateAuthorizedKeys(allKeys);

        set.status = 204;
        return null;
      } catch (error) {
        set.status = 404;
        return { error: error instanceof Error ? error.message : "Not found" };
      }
    },
    {
      params: IdParamSchema,
    },
  );
