import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ImageJsonConfig {
  name: string;
  description: string;
  volumeSize: number;
  tools: string[];
  base: string | null;
  official?: boolean;
}

export interface ImageDefinition extends ImageJsonConfig {
  id: string;
  path: string;
  hasDockerfile: boolean;
}

export interface DiscoveredImage extends ImageDefinition {
  available: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function parseImageJson(content: string): ImageJsonConfig {
  const parsed = JSON.parse(content);

  if (typeof parsed.name !== "string") {
    throw new Error("image.json: 'name' must be a string");
  }
  if (typeof parsed.description !== "string") {
    throw new Error("image.json: 'description' must be a string");
  }
  if (typeof parsed.volumeSize !== "number") {
    throw new Error("image.json: 'volumeSize' must be a number");
  }
  if (!Array.isArray(parsed.tools)) {
    throw new Error("image.json: 'tools' must be an array");
  }
  if (parsed.base !== null && typeof parsed.base !== "string") {
    throw new Error("image.json: 'base' must be a string or null");
  }

  return {
    name: parsed.name,
    description: parsed.description,
    volumeSize: parsed.volumeSize,
    tools: parsed.tools,
    base: parsed.base ?? null,
    official: parsed.official === true,
  };
}

export async function discoverImages(
  imagesDir: string,
): Promise<ImageDefinition[]> {
  const images: ImageDefinition[] = [];

  let entries: string[];
  try {
    entries = await readdir(imagesDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const imagePath = join(imagesDir, entry);
    const imageJsonPath = join(imagePath, "image.json");
    const dockerfilePath = join(imagePath, "Dockerfile");

    const hasImageJson = await fileExists(imageJsonPath);
    if (!hasImageJson) {
      continue;
    }

    try {
      const content = await readFile(imageJsonPath, "utf-8");
      const config = parseImageJson(content);
      const hasDockerfile = await fileExists(dockerfilePath);

      images.push({
        id: entry,
        path: imagePath,
        hasDockerfile,
        ...config,
      });
    } catch (error) {
      console.warn(`Failed to parse ${imageJsonPath}:`, error);
    }
  }

  return images.sort((a, b) => {
    if (a.official && !b.official) return -1;
    if (!a.official && b.official) return 1;
    return a.name.localeCompare(b.name);
  });
}

export async function getImageById(
  imagesDir: string,
  imageId: string,
): Promise<ImageDefinition | null> {
  const imagePath = join(imagesDir, imageId);
  const imageJsonPath = join(imagePath, "image.json");

  const hasImageJson = await fileExists(imageJsonPath);
  if (!hasImageJson) {
    return null;
  }

  try {
    const content = await readFile(imageJsonPath, "utf-8");
    const config = parseImageJson(content);
    const hasDockerfile = await fileExists(join(imagePath, "Dockerfile"));

    return {
      id: imageId,
      path: imagePath,
      hasDockerfile,
      ...config,
    };
  } catch {
    return null;
  }
}
