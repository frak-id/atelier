import { existsSync } from "node:fs";
import { Elysia } from "elysia";
import { exec } from "../utils/exec";

const ROOT_DEVICE = "/dev/vda";

async function ensureDeviceNode(): Promise<void> {
  if (!existsSync(ROOT_DEVICE)) {
    await exec("mknod /dev/vda b 254 0");
  }
}

export const storageRoutes = new Elysia()
  .post("/storage/resize", async () => {
    try {
      await ensureDeviceNode();
      await exec(`resize2fs ${ROOT_DEVICE}`);
      const { stdout } = await exec("df -B1 / | tail -1");
      const [, total, used, free] = stdout.split(/\s+/);
      return {
        success: true,
        disk: {
          total: parseInt(total || "0", 10),
          used: parseInt(used || "0", 10),
          free: parseInt(free || "0", 10),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })
  .get("/storage/info", async () => {
    try {
      await ensureDeviceNode();

      const { stdout: dfOutput } = await exec("df -B1 / | tail -1");
      const [, total, used, free] = dfOutput.split(/\s+/);

      const { stdout: blockdevOutput } = await exec(
        `blockdev --getsize64 ${ROOT_DEVICE} 2>/dev/null || echo 0`,
      );
      const blockSize = parseInt(blockdevOutput.trim() || "0", 10);

      return {
        filesystem: {
          total: parseInt(total || "0", 10),
          used: parseInt(used || "0", 10),
          free: parseInt(free || "0", 10),
        },
        blockDevice: blockSize,
        canResize: blockSize > parseInt(total || "0", 10),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
