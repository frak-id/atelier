import * as p from "@clack/prompts";
import { exec, commandExists } from "../lib/shell";
import { PATHS, LVM } from "../lib/context";
import { BASE_IMAGES, getAvailableImages, type BaseImageId } from "@frak-sandbox/shared/types";

const IMAGES_DIR = "/opt/frak-sandbox/infra/images";

export async function images(args: string[] = []) {
  const subcommand = args[0];

  switch (subcommand) {
    case "build":
      await buildImage(args.slice(1));
      break;
    case "list":
      await listImages();
      break;
    case "status":
      await imageStatus();
      break;
    default:
      await imagesMenu();
  }
}

async function imagesMenu() {
  const action = await p.select({
    message: "Image management",
    options: [
      { value: "build", label: "Build Image", hint: "Build a base image from Dockerfile" },
      { value: "list", label: "List Images", hint: "Show available base images" },
      { value: "status", label: "Image Status", hint: "Check which images are built" },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  switch (action) {
    case "build":
      await buildImage([]);
      break;
    case "list":
      await listImages();
      break;
    case "status":
      await imageStatus();
      break;
  }
}

async function buildImage(args: string[]) {
  p.log.step("Build Base Image");

  // Check Docker is available
  if (!(await commandExists("docker"))) {
    throw new Error("Docker is required to build images. Run: frak-sandbox base");
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

  // Check if image directory exists
  const imageDir = `${IMAGES_DIR}/${imageName}`;
  const dirExists = await exec(`test -d ${imageDir}`, { throws: false });
  if (!dirExists.success) {
    throw new Error(`Image directory not found: ${imageDir}`);
  }

  // Build Docker image
  spinner.start(`Building Docker image: frak-sandbox/${imageName}`);
  await exec(`docker build -t frak-sandbox/${imageName} ${imageDir}`);
  spinner.stop("Docker image built");

  // Create container and export
  const containerName = `sandbox-build-${imageName}-${process.pid}`;
  const tempDir = `/tmp/sandbox-build-${imageName}-${Date.now()}`;

  try {
    spinner.start("Creating container");
    await exec(`docker create --name ${containerName} frak-sandbox/${imageName}`);
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
    await exec(`dd if=/dev/zero of=${outputFile} bs=1M count=0 seek=${imageSizeMB} 2>/dev/null`);

    // Create ext4 filesystem
    await exec(`mkfs.ext4 -F -q ${outputFile}`);
    spinner.stop(`Created ${imageSizeMB}MB ext4 image`);

    // Mount and extract
    spinner.start("Extracting rootfs to image");
    const mountPoint = `${tempDir}/mnt`;
    await exec(`mkdir -p ${mountPoint}`);
    await exec(`mount -o loop ${outputFile} ${mountPoint}`);
    await exec(`tar -xf ${tempDir}/rootfs.tar -C ${mountPoint}`);
    await exec(`umount ${mountPoint}`);
    spinner.stop("Rootfs extracted");

    // Create LVM snapshot for thin provisioning
    spinner.start("Creating LVM image volume");
    const lvmVolume = `${LVM.IMAGE_PREFIX}${imageName}`;

    // Check if volume exists
    const volumeExists = await exec(
      `lvs ${LVM.VG_NAME}/${lvmVolume} 2>/dev/null`,
      { throws: false }
    );

    if (volumeExists.success) {
      // Remove existing volume
      await exec(`lvremove -f ${LVM.VG_NAME}/${lvmVolume}`);
    }

    // Create thin volume
    await exec(
      `lvcreate -V ${image.volumeSize} -T ${LVM.VG_NAME}/${LVM.THIN_POOL} -n ${lvmVolume}`
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
    await exec(`docker rm -f ${containerName} 2>/dev/null || true`, { throws: false });
    await exec(`rm -rf ${tempDir}`, { throws: false });
  }

  p.note(
    `Image ${imageName} is ready.
Sandboxes using this image will boot from:
  LVM: ${LVM.VG_NAME}/${LVM.IMAGE_PREFIX}${imageName}
  Fallback: ${PATHS.ROOTFS_DIR}/${imageName}.ext4`,
    "Build Complete"
  );
}

async function listImages() {
  p.log.step("Available Base Images");

  const images = Object.values(BASE_IMAGES);

  console.log("");
  console.log("  ID            Name                Available  Tools");
  console.log("  ─────────────────────────────────────────────────────────────");

  for (const img of images) {
    const status = img.available ? "✓" : "○";
    const tools = img.tools.slice(0, 3).join(", ") + (img.tools.length > 3 ? "..." : "");
    console.log(
      `  ${img.id.padEnd(12)}  ${img.name.padEnd(18)}  ${status.padEnd(9)}  ${tools}`
    );
  }

  console.log("");
  p.log.info("Use 'frak-sandbox images build <image-id>' to build an image");
}

async function imageStatus() {
  p.log.step("Image Build Status");

  const spinner = p.spinner();
  spinner.start("Checking image status");

  const results: Array<{
    id: string;
    name: string;
    ext4: boolean;
    lvm: boolean;
    size?: string;
  }> = [];

  for (const img of Object.values(BASE_IMAGES)) {
    if (!img.available) continue;

    const ext4Path = `${PATHS.ROOTFS_DIR}/${img.id}.ext4`;
    const lvmVolume = `${LVM.IMAGE_PREFIX}${img.id}`;

    const ext4Exists = await exec(`test -f ${ext4Path}`, { throws: false });
    const lvmExists = await exec(
      `lvs ${LVM.VG_NAME}/${lvmVolume} 2>/dev/null`,
      { throws: false }
    );

    let size: string | undefined;
    if (ext4Exists.success) {
      const { stdout } = await exec(`du -h ${ext4Path} | cut -f1`, { throws: false });
      size = stdout.trim();
    }

    results.push({
      id: img.id,
      name: img.name,
      ext4: ext4Exists.success,
      lvm: lvmExists.success,
      size,
    });
  }

  spinner.stop("Status check complete");

  console.log("");
  console.log("  Image         ext4    LVM     Size");
  console.log("  ──────────────────────────────────────────");

  for (const r of results) {
    const ext4Status = r.ext4 ? "✓" : "✗";
    const lvmStatus = r.lvm ? "✓" : "✗";
    const size = r.size || "-";
    console.log(
      `  ${r.id.padEnd(12)}  ${ext4Status.padEnd(6)}  ${lvmStatus.padEnd(6)}  ${size}`
    );
  }

  console.log("");

  const allBuilt = results.every((r) => r.ext4 && r.lvm);
  if (allBuilt) {
    p.log.success("All available images are built");
  } else {
    const missing = results.filter((r) => !r.ext4 || !r.lvm).map((r) => r.id);
    p.log.warn(`Missing images: ${missing.join(", ")}`);
    p.log.info("Run 'frak-sandbox images build' to build missing images");
  }
}
