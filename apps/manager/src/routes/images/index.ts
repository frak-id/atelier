import {
  getAllImages,
  getAvailableImages,
  getBaseImage,
  type BaseImageId,
} from "@frak-sandbox/shared/types";
import { Elysia, t } from "elysia";
import { NotFoundError } from "../../lib/errors.ts";

const ImageResponse = t.Object({
  id: t.String(),
  name: t.String(),
  description: t.String(),
  volumeSize: t.Number(),
  tools: t.Array(t.String()),
  volumeName: t.String(),
  available: t.Boolean(),
});

export const imageRoutes = new Elysia({ prefix: "/images" })
  .get(
    "/",
    ({ query }) => {
      const images =
        query.all === "true" ? getAllImages() : getAvailableImages();
      return images;
    },
    {
      query: t.Object({
        all: t.Optional(t.String()),
      }),
      response: t.Array(ImageResponse),
    },
  )
  .get(
    "/:id",
    ({ params }) => {
      const image = getBaseImage(params.id as BaseImageId);
      if (!image) {
        throw new NotFoundError("Image", params.id);
      }
      return image;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      response: ImageResponse,
    },
  );
