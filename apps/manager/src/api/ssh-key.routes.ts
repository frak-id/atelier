import { Buffer } from "node:buffer";
import { Elysia } from "elysia";
import { sshKeyService } from "../container.ts";
import { kubeClient } from "../infrastructure/kubernetes/index.ts";
import {
  CreateSshKeyBodySchema,
  HasSshKeysResponseSchema,
  IdParamSchema,
  SshKeyListResponseSchema,
  SshKeySchema,
} from "../schemas/index.ts";
import type { AuthUser } from "../shared/lib/auth.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("ssh-key-routes");

async function syncAuthorizedKeysToPipes(): Promise<void> {
  try {
    const publicKeys = sshKeyService.getValidPublicKeys();
    const authorizedKeysData =
      publicKeys.length > 0
        ? Buffer.from(publicKeys.map((key) => key.trim()).join("\n")).toString(
            "base64",
          )
        : undefined;

    const namespace = config.kubernetes.namespace;
    const path =
      "/apis/sshpiper.com/v1beta1/namespaces/" +
      `${namespace}/pipes?labelSelector=${encodeURIComponent("atelier.dev/component=ssh-pipe")}`;
    const result = await kubeClient.list<{
      items?: Array<{
        metadata?: { name?: string; namespace?: string };
        spec?: { from?: Array<Record<string, unknown>>; to?: unknown };
      }>;
    }>(path);

    for (const pipe of result.items ?? []) {
      const name = pipe.metadata?.name;
      if (!name) continue;

      const patchPath = `/apis/sshpiper.com/v1beta1/namespaces/${namespace}/pipes/${name}`;
      const fromEntries = pipe.spec?.from ?? [];
      const updatedFrom = fromEntries.map((entry) => ({
        ...entry,
        authorized_keys_data: authorizedKeysData,
      }));

      await kubeClient.patch(patchPath, {
        spec: { from: updatedFrom },
      });
    }

    log.info(
      { pipeCount: (result.items ?? []).length, keyCount: publicKeys.length },
      "SSH authorized keys synced to Pipe CRDs",
    );
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to sync SSH keys to Pipe CRDs",
    );
  }
}

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

      void syncAuthorizedKeysToPipes();

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
        void syncAuthorizedKeysToPipes();
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
