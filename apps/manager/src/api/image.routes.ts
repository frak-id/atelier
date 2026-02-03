import { discoverImages, getImageById } from "@frak-sandbox/shared";
import { Elysia } from "elysia";
import { StorageService } from "../infrastructure/storage/index.ts";
import {
  BaseImageSchema,
  IdParamSchema,
  ImageListQuerySchema,
  ImageListResponseSchema,
} from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";

export const imageRoutes = new Elysia({ prefix: "/images" })
  .get(
    "/",
    async ({ query }) => {
      const images = await discoverImages(config.images.directory);

      const imagesWithAvailability = await Promise.all(
        images.map(async (img) => ({
          id: img.id,
          name: img.name,
          description: img.description,
          volumeSize: img.volumeSize,
          tools: img.tools,
          base: img.base,
          official: img.official,
          available: await StorageService.hasImageVolume(img.id),
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
      const image = await getImageById(config.images.directory, params.id);
      if (!image) {
        throw new NotFoundError("Image", params.id);
      }

      const available = await StorageService.hasImageVolume(image.id);
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
  );
