import * as p from "@clack/prompts";
import {
  discoverImages,
  getImageById,
  type ImageDefinition,
} from "@frak/atelier-shared";
import { VM } from "@frak/atelier-shared/constants";
import { atelierConfig, LVM, PATHS } from "../lib/context";
import { commandExists, exec } from "../lib/shell";

const BUILD_ALL = "@@build-all" as const;
const BUILD_ALL_NO_CACHE = "@@build-all-no-cache" as const;

export async function images(args: string[] = []) {
  const noCache = args.includes("--no-cache");
  const positionalArgs = args.filter((a) => !a.startsWith("--"));

  p.log.step("Build Base Image");

  const imagesDir = atelierConfig.sandbox.imagesDirectory;

  if (!(await commandExists("docker"))) {
    throw new Error("Docker is required to build images. Run: atelier base");
  }

  const availableImages = await discoverImages(imagesDir);
  const buildableImages = availableImages.filter((img) => img.hasDockerfile);

  if (buildableImages.length === 0) {
    throw new Error(
      `No images found in ${imagesDir}. Each image needs a folder with Dockerfile and image.json.`,
    );
  }

  const imageArg = positionalArgs[0];

  if (imageArg) {
    const image = await getImageById(imagesDir, imageArg);
    if (!image) {
      throw new Error(`Unknown image: ${imageArg}`);
    }
    await buildSingleImage(image, noCache);
    return;
  }

  const selected = await p.select({
    message: "Select image to build",
    options: [
      ...buildableImages.map((img) => ({
        value: img.id,
        label: img.name,
        hint: img.description,
      })),
      { value: BUILD_ALL, label: "Build all", hint: "Sequential build" },
      {
        value: BUILD_ALL_NO_CACHE,
        label: "Build all (no cache)",
        hint: "Sequential build, ignoring Docker cache",
      },
    ],
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  if (selected === BUILD_ALL || selected === BUILD_ALL_NO_CACHE) {
    const useNoCache = selected === BUILD_ALL_NO_CACHE || noCache;
    const sorted = sortByDependency(buildableImages);
    for (const image of sorted) {
      await buildSingleImage(image, useNoCache);
    }
    return;
  }

  const image = buildableImages.find((img) => img.id === selected) ?? null;
  if (!image) {
    throw new Error("No image selected");
  }
  await buildSingleImage(image, noCache);
}

function sortByDependency(images: ImageDefinition[]): ImageDefinition[] {
  const byId = new Map(images.map((img) => [img.id, img]));
  const sorted: ImageDefinition[] = [];
  const visited = new Set<string>();

  function visit(image: ImageDefinition) {
    if (visited.has(image.id)) return;
    visited.add(image.id);

    if (image.base) {
      const dep = byId.get(image.base);
      if (dep) visit(dep);
    }

    sorted.push(image);
  }

  for (const image of images) {
    visit(image);
  }

  return sorted;
}

async function buildSingleImage(image: ImageDefinition, noCache: boolean) {
  if (!image.hasDockerfile) {
    throw new Error(
      `Image ${image.id} has no Dockerfile at ${image.path}/Dockerfile`,
    );
  }

  const imagesDir = atelierConfig.sandbox.imagesDirectory;
  const spinner = p.spinner();
  const imageDir = image.path;
  const imageName = image.id;

  p.log.step(`Building ${image.name} (${imageName})`);

  const agentBinary = `${imagesDir}/sandbox-agent`;
  const agentExists = await exec(`test -f ${agentBinary}`, { throws: false });
  if (!agentExists.success) {
    throw new Error(
      `sandbox-agent binary not found at: ${agentBinary}\n` +
        "Run 'atelier update' to download server assets.",
    );
  }

  spinner.start("Preparing build context");
  await exec(`cp ${agentBinary} ${imageDir}/sandbox-agent`);
  spinner.stop("Build context ready");

  spinner.start(`Building Docker image: atelier/${imageName}`);
  try {
    const buildArgs = [
      `--build-arg OPENCODE_VERSION=${atelierConfig.advanced.vm.opencode.version}`,
      `--build-arg CODE_SERVER_VERSION=${atelierConfig.advanced.vm.vscode.version}`,
    ].join(" ");
    const cacheFlag = noCache ? "--no-cache " : "";
    await exec(
      `docker build ${cacheFlag}${buildArgs} -t atelier/${imageName} ${imageDir}`,
    );
  } finally {
    await exec(`rm -f ${imageDir}/sandbox-agent`, { throws: false });
  }
  spinner.stop("Docker image built");

  const containerName = `sandbox-build-${imageName}-${process.pid}`;
  const tempDir = `/tmp/sandbox-build-${imageName}-${Date.now()}`;

  try {
    spinner.start("Creating container");
    await exec(`docker create --name ${containerName} atelier/${imageName}`);
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
    await exec(`chown -R ${VM.OWNER} ${mountPoint}/home/dev/.ssh`);

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

    if (imageName === atelierConfig.sandbox.defaultImage) {
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
