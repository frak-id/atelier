import {
  SHARED_BINARIES,
  type SharedBinaryId,
} from "@frak-sandbox/shared/constants";
import { Elysia } from "elysia";
import { SharedStorageService } from "../../infrastructure/storage/index.ts";
import {
  BinaryIdParamSchema,
  BinaryInfoSchema,
  BinaryInstallResultSchema,
  BinaryListSchema,
  CacheFolderParamSchema,
  CacheInfoSchema,
  CachePurgeResultSchema,
  NfsStatusSchema,
  SharedStorageStatusSchema,
} from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";

function isValidBinaryId(id: string): id is SharedBinaryId {
  return id in SHARED_BINARIES;
}

export const sharedStorageRoutes = new Elysia({ prefix: "/storage" })
  .get(
    "/",
    async () => {
      const [nfs, binaries, cache] = await Promise.all([
        SharedStorageService.getNfsStatus(),
        SharedStorageService.listBinaries(),
        SharedStorageService.getCacheInfo(),
      ]);
      return { nfs, binaries, cache };
    },
    {
      response: SharedStorageStatusSchema,
      detail: {
        tags: ["storage"],
        summary: "Get full shared storage status",
      },
    },
  )
  .get(
    "/nfs",
    async () => {
      return SharedStorageService.getNfsStatus();
    },
    {
      response: NfsStatusSchema,
      detail: {
        tags: ["storage"],
        summary: "Get NFS server status",
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
      return SharedStorageService.installBinary(params.id);
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
      return SharedStorageService.removeBinary(params.id);
    },
    {
      params: BinaryIdParamSchema,
      response: BinaryInstallResultSchema,
      detail: {
        tags: ["storage"],
        summary: "Remove an installed shared binary",
      },
    },
  )
  .get(
    "/cache",
    async () => {
      return SharedStorageService.getCacheInfo();
    },
    {
      response: CacheInfoSchema,
      detail: {
        tags: ["storage"],
        summary: "Get package cache information",
      },
    },
  )
  .delete(
    "/cache/:folder",
    async ({ params }) => {
      return SharedStorageService.purgeCache(params.folder);
    },
    {
      params: CacheFolderParamSchema,
      response: CachePurgeResultSchema,
      detail: {
        tags: ["storage"],
        summary: "Purge a specific cache folder",
      },
    },
  );
