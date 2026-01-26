import { Elysia } from "elysia";
import { StorageService } from "../infrastructure/storage/index.ts";
import {
  type BaseImageId,
  BaseImageSchema,
  getAllImages,
  getAvailableImages,
  getBaseImage,
  IdParamSchema,
  ImageListQuerySchema,
  ImageListResponseSchema,
} from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";

export const imageRoutes = new Elysia({ prefix: "/images" })
  .get(
    "/",
    async ({ query }) => {
      const images = query.all ? getAllImages() : getAvailableImages();

      const imagesWithAvailability = await Promise.all(
        images.map(async (img) => ({
          ...img,
          available: await StorageService.hasImageVolume(img.id),
        })),
      );

      return imagesWithAvailability;
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
      const image = getBaseImage(params.id as BaseImageId);
      if (!image) {
        throw new NotFoundError("Image", params.id);
      }

      const available = await StorageService.hasImageVolume(image.id);
      return { ...image, available };
    },
    {
      params: IdParamSchema,
      response: BaseImageSchema,
      detail: { tags: ["images"] },
    },
  );
