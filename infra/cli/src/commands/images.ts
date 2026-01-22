import * as p from "@clack/prompts";
import {
  BASE_IMAGES,
  type BaseImageId,
  getAvailableImages,
} from "@frak-sandbox/manager/types";
import { CODE_SERVER, LVM, OPENCODE, PATHS, TTYD } from "../lib/context";
import { commandExists, exec } from "../lib/shell";

const IMAGES_DIR = "/opt/frak-sandbox/infra/images";

export async function images(args: string[] = []) {
  await buildImage(args);
}

async function buildImage(args: string[]) {
  p.log.step("Build Base Image");

  // Check Docker is available
  if (!(await commandExists("docker"))) {
    throw new Error(
      "Docker is required to build images. Run: frak-sandbox base",
    );
  }

  // Get image to build
  let imageName = args[0] as BaseImageId | undefined;

  if (!imageName) {
    const availableImages = getAvailableImages();
    const imageOptions = availableImages.map((img) => ({
      value: img.id,
      label: img.name,
      hint: img.description,
    }));

    if (imageOptions.length === 0) {
      throw new Error("No images available to build");
    }

    const selected = await p.select({
      message: "Select image to build",
      options: imageOptions,
    });

    if (p.isCancel(selected)) {
      p.cancel("Cancelled");
      process.exit(0);
    }

    imageName = selected as BaseImageId;
  }

  const image = BASE_IMAGES[imageName];
  if (!image) {
    throw new Error(`Unknown image: ${imageName}`);
  }

  if (!image.available) {
    throw new Error(`Image ${imageName} is not available yet`);
  }

  const spinner = p.spinner();

  const imageDir = `${IMAGES_DIR}/${imageName}`;
  const dirExists = await exec(`test -d ${imageDir}`, { throws: false });
  if (!dirExists.success) {
    throw new Error(`Image directory not found: ${imageDir}`);
  }

  const agentScript = `${IMAGES_DIR}/sandbox-agent.mjs`;
  const agentExists = await exec(`test -f ${agentScript}`, { throws: false });
  if (!agentExists.success) {
    throw new Error(
      `sandbox-agent.mjs not found at: ${agentScript}\n` +
        `Deploy with 'bun run deploy' first, or build manually on dev machine:\n` +
        `  cd packages/sandbox-agent && bun run build`,
    );
  }

  spinner.start("Preparing build context");
  await exec(`cp ${agentScript} ${imageDir}/sandbox-agent.mjs`);
  spinner.stop("Build context ready");

  spinner.start(`Building Docker image: frak-sandbox/${imageName}`);
  try {
    const buildArgs = [
      `--build-arg OPENCODE_VERSION=${OPENCODE.VERSION}`,
      `--build-arg CODE_SERVER_VERSION=${CODE_SERVER.VERSION}`,
      `--build-arg TTYD_VERSION=${TTYD.VERSION}`,
    ].join(" ");
    await exec(
      `docker build --no-cache ${buildArgs} -t frak-sandbox/${imageName} ${imageDir}`,
    );
  } finally {
    await exec(`rm -f ${imageDir}/sandbox-agent.mjs`, { throws: false });
  }
  spinner.stop("Docker image built");

  // Create container and export
  const containerName = `sandbox-build-${imageName}-${process.pid}`;
  const tempDir = `/tmp/sandbox-build-${imageName}-${Date.now()}`;

  try {
    spinner.start("Creating container");
    await exec(
      `docker create --name ${containerName} frak-sandbox/${imageName}`,
    );
    spinner.stop("Container created");

    spinner.start("Exporting filesystem");
    await exec(`mkdir -p ${tempDir}`);
    await exec(`docker export ${containerName} -o ${tempDir}/rootfs.tar`);
    spinner.stop("Filesystem exported");

    // Calculate size and create ext4 image
    spinner.start("Creating ext4 image");
    const { stdout: tarSize } = await exec(`stat -c%s ${tempDir}/rootfs.tar`);
    const imageSizeMB = Math.ceil(parseInt(tarSize, 10) / 1024 / 1024) + 500;

    await exec(`mkdir -p ${PATHS.ROOTFS_DIR}`);
    const outputFile = `${PATHS.ROOTFS_DIR}/${imageName}.ext4`;

    // Create sparse file
    await exec(
      `dd if=/dev/zero of=${outputFile} bs=1M count=0 seek=${imageSizeMB} 2>/dev/null`,
    );

    // Create ext4 filesystem
    await exec(`mkfs.ext4 -F -q ${outputFile}`);
    spinner.stop(`Created ${imageSizeMB}MB ext4 image`);

    // Mount and extract
    spinner.start("Extracting rootfs to image");
    const mountPoint = `${tempDir}/mnt`;
    await exec(`mkdir -p ${mountPoint}`);
    await exec(`mount -o loop ${outputFile} ${mountPoint}`);
    await exec(`tar -xf ${tempDir}/rootfs.tar -C ${mountPoint}`);

    // Inject VM SSH key for sshpiper authentication
    const sshKeyPath = `${PATHS.ROOTFS_DIR}/vm-ssh-key`;
    await exec(`mkdir -p ${mountPoint}/root/.ssh`);
    await exec(`cp ${sshKeyPath}.pub ${mountPoint}/root/.ssh/authorized_keys`);
    await exec(`chmod 700 ${mountPoint}/root/.ssh`);
    await exec(`chmod 600 ${mountPoint}/root/.ssh/authorized_keys`);

    await exec(`umount ${mountPoint}`);
    spinner.stop("Rootfs extracted with SSH key");

    // Create LVM snapshot for thin provisioning
    spinner.start("Creating LVM image volume");
    const lvmVolume = `${LVM.IMAGE_PREFIX}${imageName}`;

    // Check if volume exists
    const volumeExists = await exec(
      `lvs ${LVM.VG_NAME}/${lvmVolume} 2>/dev/null`,
      { throws: false },
    );

    if (volumeExists.success) {
      // Remove existing volume
      await exec(`lvremove -f ${LVM.VG_NAME}/${lvmVolume}`);
    }

    // Create thin volume (volumeSize is in GB)
    await exec(
      `lvcreate -V ${image.volumeSize}G -T ${LVM.VG_NAME}/${LVM.THIN_POOL} -n ${lvmVolume}`,
    );

    // Copy ext4 image to LVM volume
    await exec(`dd if=${outputFile} of=/dev/${LVM.VG_NAME}/${lvmVolume} bs=4M`);
    spinner.stop("LVM image volume created");

    // Create symlink if dev-base
    if (imageName === "dev-base") {
      await exec(`ln -sf ${imageName}.ext4 ${PATHS.ROOTFS_DIR}/rootfs.ext4`);
      p.log.info("Created symlink: rootfs.ext4 -> dev-base.ext4");
    }

    const { stdout: finalSize } = await exec(`du -h ${outputFile} | cut -f1`);
    p.log.success(`Image built: ${outputFile} (${finalSize.trim()})`);
    p.log.success(`LVM volume: ${LVM.VG_NAME}/${lvmVolume}`);
  } finally {
    // Cleanup
    await exec(`docker rm -f ${containerName} 2>/dev/null || true`, {
      throws: false,
    });
    await exec(`rm -rf ${tempDir}`, { throws: false });
  }

  p.note(
    `Image ${imageName} is ready.
Sandboxes using this image will boot from:
  LVM: ${LVM.VG_NAME}/${LVM.IMAGE_PREFIX}${imageName}
  Fallback: ${PATHS.ROOTFS_DIR}/${imageName}.ext4`,
    "Build Complete",
  );
}
