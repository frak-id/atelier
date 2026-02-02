import * as p from "@clack/prompts";
import {
  discoverImages,
  getImageById,
  type ImageDefinition,
} from "@frak-sandbox/shared";
import { CODE_SERVER, frakConfig, LVM, OPENCODE, PATHS } from "../lib/context";
import { commandExists, exec } from "../lib/shell";

export async function images(args: string[] = []) {
  await buildImage(args);
}

async function buildImage(args: string[]) {
  p.log.step("Build Base Image");

  const imagesDir = frakConfig.images.directory;

  if (!(await commandExists("docker"))) {
    throw new Error(
      "Docker is required to build images. Run: frak-sandbox base",
    );
  }

  let image: ImageDefinition | null = null;
  const imageArg = args[0];

  if (imageArg) {
    image = await getImageById(imagesDir, imageArg);
    if (!image) {
      throw new Error(`Unknown image: ${imageArg}`);
    }
  } else {
    const availableImages = await discoverImages(imagesDir);
    const buildableImages = availableImages.filter((img) => img.hasDockerfile);

    if (buildableImages.length === 0) {
      throw new Error(
        `No images found in ${imagesDir}. Each image needs a folder with Dockerfile and image.json.`,
      );
    }

    const imageOptions = buildableImages.map((img) => ({
      value: img.id,
      label: img.name,
      hint: img.description,
    }));

    const selected = await p.select({
      message: "Select image to build",
      options: imageOptions,
    });

    if (p.isCancel(selected)) {
      p.cancel("Cancelled");
      process.exit(0);
    }

    image = buildableImages.find((img) => img.id === selected) ?? null;
  }

  if (!image) {
    throw new Error("No image selected");
  }

  if (!image.hasDockerfile) {
    throw new Error(
      `Image ${image.id} has no Dockerfile at ${image.path}/Dockerfile`,
    );
  }

  const spinner = p.spinner();
  const imageDir = image.path;
  const imageName = image.id;

  const agentBinary = `${imagesDir}/sandbox-agent`;
  const agentExists = await exec(`test -f ${agentBinary}`, { throws: false });
  if (!agentExists.success) {
    throw new Error(
      `sandbox-agent binary not found at: ${agentBinary}\n` +
        "Run 'frak-sandbox update' to download server assets.",
    );
  }

  spinner.start("Preparing build context");
  await exec(`cp ${agentBinary} ${imageDir}/sandbox-agent`);
  spinner.stop("Build context ready");

  spinner.start(`Building Docker image: frak-sandbox/${imageName}`);
  try {
    const buildArgs = [
      `--build-arg OPENCODE_VERSION=${OPENCODE.VERSION}`,
      `--build-arg CODE_SERVER_VERSION=${CODE_SERVER.VERSION}`,
    ].join(" ");
    await exec(
      `docker build --no-cache ${buildArgs} -t frak-sandbox/${imageName} ${imageDir}`,
    );
  } finally {
    await exec(`rm -f ${imageDir}/sandbox-agent`, { throws: false });
  }
  spinner.stop("Docker image built");

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

    spinner.start("Creating ext4 image");
    const { stdout: tarSize } = await exec(`stat -c%s ${tempDir}/rootfs.tar`);
    const imageSizeMB = Math.ceil(parseInt(tarSize, 10) / 1024 / 1024) + 500;

    await exec(`mkdir -p ${PATHS.ROOTFS_DIR}`);
    const outputFile = `${PATHS.ROOTFS_DIR}/${imageName}.ext4`;

    await exec(
      `dd if=/dev/zero of=${outputFile} bs=1M count=0 seek=${imageSizeMB} 2>/dev/null`,
    );

    await exec(`mkfs.ext4 -F -q ${outputFile}`);
    spinner.stop(`Created ${imageSizeMB}MB ext4 image`);

    spinner.start("Extracting rootfs to image");
    const mountPoint = `${tempDir}/mnt`;
    await exec(`mkdir -p ${mountPoint}`);
    await exec(`mount -o loop ${outputFile} ${mountPoint}`);
    await exec(`tar -xf ${tempDir}/rootfs.tar -C ${mountPoint}`);

    const sshKeyPath = `${PATHS.ROOTFS_DIR}/vm-ssh-key`;
    await exec(`mkdir -p ${mountPoint}/root/.ssh`);
    await exec(`cp ${sshKeyPath}.pub ${mountPoint}/root/.ssh/authorized_keys`);
    await exec(`chmod 700 ${mountPoint}/root/.ssh`);
    await exec(`chmod 600 ${mountPoint}/root/.ssh/authorized_keys`);

    await exec(`mkdir -p ${mountPoint}/home/dev/.ssh`);
    await exec(
      `cp ${sshKeyPath}.pub ${mountPoint}/home/dev/.ssh/authorized_keys`,
    );
    await exec(`chmod 700 ${mountPoint}/home/dev/.ssh`);
    await exec(`chmod 600 ${mountPoint}/home/dev/.ssh/authorized_keys`);
    await exec(`chown -R 1000:1000 ${mountPoint}/home/dev/.ssh`);

    await exec(`umount ${mountPoint}`);
    spinner.stop("Rootfs extracted with SSH key");

    spinner.start("Creating LVM image volume");
    const lvmVolume = `${LVM.IMAGE_PREFIX}${imageName}`;

    const volumeExists = await exec(
      `lvs ${LVM.VG_NAME}/${lvmVolume} 2>/dev/null`,
      { throws: false },
    );

    if (volumeExists.success) {
      await exec(`lvremove -f ${LVM.VG_NAME}/${lvmVolume}`);
    }

    await exec(
      `lvcreate -V ${image.volumeSize}G -T ${LVM.VG_NAME}/${LVM.THIN_POOL} -n ${lvmVolume}`,
    );

    await exec(`dd if=${outputFile} of=/dev/${LVM.VG_NAME}/${lvmVolume} bs=4M`);
    spinner.stop("LVM image volume created");

    if (imageName === frakConfig.images.defaultImage) {
      await exec(`ln -sf ${imageName}.ext4 ${PATHS.ROOTFS_DIR}/rootfs.ext4`);
      p.log.info(`Created symlink: rootfs.ext4 -> ${imageName}.ext4`);
    }

    const { stdout: finalSize } = await exec(`du -h ${outputFile} | cut -f1`);
    p.log.success(`Image built: ${outputFile} (${finalSize.trim()})`);
    p.log.success(`LVM volume: ${LVM.VG_NAME}/${lvmVolume}`);
  } finally {
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
