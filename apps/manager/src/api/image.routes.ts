import { discoverImages, getImageById } from "@frak/atelier-shared";
import { Elysia, t } from "elysia";
import { baseImageBuilder } from "../container.ts";
import {
  BaseImageSchema,
  IdParamSchema,
  ImageBuildListResponseSchema,
  ImageBuildSchema,
  ImageBuildTriggerResponseSchema,
  ImageListQuerySchema,
  ImageListResponseSchema,
} from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("image-routes");

export const imageRoutes = new Elysia({ prefix: "/images" })
  .get(
    "/",
    async ({ query }) => {
      const images = await discoverImages(config.sandbox.imagesDirectory);

      const imagesWithAvailability = await Promise.all(
        images.map(async (img) => ({
          id: img.id,
          name: img.name,
          description: img.description,
          volumeSize: img.volumeSize,
          tools: img.tools,
          base: img.base,
          official: img.official,
          available: true,
        })),
      );

      if (query.all) {
        return imagesWithAvailability;
      }
      return imagesWithAvailability.filter((img) => img.available);
    },
    {
      query: ImageListQuerySchema,
      response: ImageListResponseSchema,
      detail: { tags: ["images"] },
    },
  )
  .get(
    "/:id",
    async ({ params }) => {
      const image = await getImageById(
        config.sandbox.imagesDirectory,
        params.id,
      );
      if (!image) {
        throw new NotFoundError("Image", params.id);
      }

      const available = true;
      return {
        id: image.id,
        name: image.name,
        description: image.description,
        volumeSize: image.volumeSize,
        tools: image.tools,
        base: image.base,
        official: image.official,
        available,
      };
    },
    {
      params: IdParamSchema,
      response: BaseImageSchema,
      detail: { tags: ["images"] },
    },
  )
  .get(
    "/builds",
    async () => {
      return baseImageBuilder.listBuilds();
    },
    {
      response: ImageBuildListResponseSchema,
      detail: { tags: ["images"] },
    },
  )
  .get(
    "/:id/build",
    async ({ params }) => {
      return baseImageBuilder.getBuildStatus(params.id);
    },
    {
      params: IdParamSchema,
      response: ImageBuildSchema,
      detail: { tags: ["images"] },
    },
  )
  .post(
    "/:id/build",
    async ({ params, set }) => {
      log.info({ imageId: params.id }, "Triggering base image build");
      const result = await baseImageBuilder.triggerBuild(params.id);
      set.status = 202;
      return result;
    },
    {
      params: IdParamSchema,
      response: ImageBuildTriggerResponseSchema,
      detail: { tags: ["images"] },
    },
  )
  .delete(
    "/:id/build",
    async ({ params, set }) => {
      log.info({ imageId: params.id }, "Cancelling base image build");
      await baseImageBuilder.cancelBuild(params.id);
      set.status = 204;
    },
    {
      params: IdParamSchema,
      response: t.Void(),
      detail: { tags: ["images"] },
    },
  );
