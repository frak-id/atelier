import {
  type BaseImageId,
  getAllImages,
  getAvailableImages,
  getBaseImage,
} from "@frak-sandbox/shared/types";
import { Elysia, t } from "elysia";
import { NotFoundError } from "../../lib/errors.ts";
import { StorageService } from "../../services/storage.ts";

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
      query: t.Object({
        all: t.Optional(t.BooleanString()),
      }),
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
      params: t.Object({ id: t.String() }),
      detail: { tags: ["images"] },
    },
  );
