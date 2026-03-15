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
import { authPlugin } from "../shared/lib/auth.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("ssh-key-routes");

const SYNC_BATCH_SIZE = 5;

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
      `${namespace}/pipes?labelSelector=` +
      `${encodeURIComponent("atelier.dev/component=ssh-pipe")}`;
    const result = await kubeClient.list<{
      items?: Array<{
        metadata?: { name?: string; namespace?: string };
        spec?: {
          from?: Array<Record<string, unknown>>;
          to?: unknown;
        };
      }>;
    }>(path);

    const pipes = result.items ?? [];
    let failCount = 0;

    for (let i = 0; i < pipes.length; i += SYNC_BATCH_SIZE) {
      const batch = pipes.slice(i, i + SYNC_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((pipe) => {
          const name = pipe.metadata?.name;
          if (!name) {
            return Promise.resolve();
          }
          const patchPath =
            `/apis/sshpiper.com/v1beta1/namespaces/` +
            `${namespace}/pipes/${name}`;
          const fromEntries = pipe.spec?.from ?? [];
          const updatedFrom = fromEntries.map((entry) => ({
            ...entry,
            authorized_keys_data: authorizedKeysData,
          }));
          return kubeClient.patch(patchPath, {
            spec: { from: updatedFrom },
          });
        }),
      );

      for (const r of results) {
        if (r.status === "rejected") {
          failCount++;
          log.warn(
            {
              error:
                r.reason instanceof Error ? r.reason.message : String(r.reason),
            },
            "Failed to patch pipe",
          );
        }
      }
    }

    log.info(
      {
        pipeCount: pipes.length,
        keyCount: publicKeys.length,
        failCount,
      },
      "SSH authorized keys synced to Pipe CRDs",
    );
  } catch (error) {
    log.warn(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to sync SSH keys to Pipe CRDs",
    );
  }
}

export const sshKeyRoutes = new Elysia({ prefix: "/ssh-keys" })
  .use(authPlugin)
  .get(
    "/",
    ({ user }) => {
      return sshKeyService.listByUserId(user.id);
    },
    {
      response: SshKeyListResponseSchema,
    },
  )
  .get(
    "/has-keys",
    ({ user }) => {
      return { hasKeys: sshKeyService.hasKeysForUser(user.id) };
    },
    {
      response: HasSshKeysResponseSchema,
    },
  )
  .post(
    "/",
    async ({ body, user }) => {
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
    async ({ params, user, set }) => {
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
