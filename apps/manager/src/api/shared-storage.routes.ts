import {
  getSharedBinaries,
  type SharedBinaryId,
} from "@frak/atelier-shared/constants";
import { Elysia } from "elysia";
import { SharedStorageService } from "../infrastructure/storage/index.ts";
import {
  BinaryIdParamSchema,
  BinaryInfoSchema,
  BinaryInstallResultSchema,
  BinaryListSchema,
  SharedStorageStatusSchema,
} from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("shared-storage-routes");

const SHARED_BINARIES = getSharedBinaries({
  opencode: config.raw.versions.opencode,
  codeServer: config.raw.versions.codeServer,
});

function isValidBinaryId(id: string): id is SharedBinaryId {
  return id in SHARED_BINARIES;
}

function rebuildImageInBackground(): void {
  SharedStorageService.buildBinariesImage()
    .then((result) => {
      if (result.success) {
        log.info({ sizeBytes: result.sizeBytes }, "Binaries image rebuilt");
      } else {
        log.error({ error: result.error }, "Failed to rebuild binaries image");
      }
    })
    .catch((error) => {
      log.error({ error }, "Binaries image rebuild crashed");
    });
}

export const sharedStorageRoutes = new Elysia({ prefix: "/storage" })
  .get(
    "/",
    async () => {
      const [binaries, image] = await Promise.all([
        SharedStorageService.listBinaries(),
        SharedStorageService.getBinariesImageInfo(),
      ]);
      return { binaries, image };
    },
    {
      response: SharedStorageStatusSchema,
      detail: {
        tags: ["storage"],
        summary: "Get shared storage status",
      },
    },
  )

  .get(
    "/binaries",
    async () => {
      return SharedStorageService.listBinaries();
    },
    {
      response: BinaryListSchema,
      detail: {
        tags: ["storage"],
        summary: "List all available shared binaries",
      },
    },
  )
  .get(
    "/binaries/:id",
    async ({ params }) => {
      if (!isValidBinaryId(params.id)) {
        throw new NotFoundError("Binary", params.id);
      }
      const binary = await SharedStorageService.getBinary(params.id);
      if (!binary) {
        throw new NotFoundError("Binary", params.id);
      }
      return binary;
    },
    {
      params: BinaryIdParamSchema,
      response: BinaryInfoSchema,
      detail: {
        tags: ["storage"],
        summary: "Get info about a specific binary",
      },
    },
  )
  .post(
    "/binaries/:id/install",
    async ({ params }) => {
      if (!isValidBinaryId(params.id)) {
        throw new NotFoundError("Binary", params.id);
      }
      const result = await SharedStorageService.installBinary(params.id);
      if (result.success) rebuildImageInBackground();
      return result;
    },
    {
      params: BinaryIdParamSchema,
      response: BinaryInstallResultSchema,
      detail: {
        tags: ["storage"],
        summary: "Download and install a shared binary",
      },
    },
  )
  .delete(
    "/binaries/:id",
    async ({ params }) => {
      if (!isValidBinaryId(params.id)) {
        throw new NotFoundError("Binary", params.id);
      }
      const result = await SharedStorageService.removeBinary(params.id);
      if (result.success) rebuildImageInBackground();
      return result;
    },
    {
      params: BinaryIdParamSchema,
      response: BinaryInstallResultSchema,
      detail: {
        tags: ["storage"],
        summary: "Remove an installed shared binary",
      },
    },
  );
