import * as p from "@clack/prompts";
import { LVM } from "../lib/context";
import { exec, fileExists } from "../lib/shell";

const LOOP_FILE = "/var/lib/sandbox/thin-pool.img";
const DEFAULT_LOOP_SIZE_GB = 100;

export async function setupStorage(_args: string[] = []) {
  p.log.step("Phase 2: Storage Setup (LVM Thin Provisioning)");

  const existingVg = await exec(`vgs ${LVM.VG_NAME}`, { throws: false });
  if (existingVg.success) {
    p.log.warn(`Volume group '${LVM.VG_NAME}' already exists`);
    await showStorageStatus();

    const action = await p.select({
      message: "Storage already configured. What would you like to do?",
      options: [
        { value: "status", label: "Show status only" },
        { value: "test", label: "Test snapshot performance" },
        {
          value: "destroy",
          label: "Destroy and recreate",
          hint: "⚠️  Deletes all sandbox data",
        },
      ],
    });

    if (p.isCancel(action) || action === "status") {
      return;
    }

    if (action === "test") {
      const spinner = p.spinner();
      await testSnapshotPerformance(spinner);
      return;
    }

    if (action === "destroy") {
      await destroyStorage();
    }
  }

  await showDiskLayout();

  const method = await p.select({
    message: "How would you like to set up storage?",
    options: [
      {
        value: "loop",
        label: "Loop file (recommended)",
        hint: "Uses a file on existing filesystem - no partition needed",
      },
      {
        value: "device",
        label: "Block device",
        hint: "Uses a dedicated partition - better performance",
      },
    ],
  });

  if (p.isCancel(method)) {
    p.cancel("Cancelled");
    return;
  }

  const spinner = p.spinner();

  if (method === "loop") {
    await setupWithLoopFile(spinner);
  } else {
    await setupWithDevice(spinner);
  }

  p.log.success("Storage setup complete");
  await showStorageStatus();
}

async function setupWithLoopFile(spinner: ReturnType<typeof p.spinner>) {
  const sizeInput = await p.text({
    message: "Size of thin pool in GB?",
    placeholder: String(DEFAULT_LOOP_SIZE_GB),
    initialValue: String(DEFAULT_LOOP_SIZE_GB),
    validate: (value: string) => {
      const num = parseInt(value, 10);
      if (Number.isNaN(num) || num < 10) return "Minimum 10GB";
      return undefined;
    },
  });

  if (p.isCancel(sizeInput)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const sizeGb = parseInt(sizeInput, 10);

  spinner.start(`Creating ${sizeGb}GB sparse file`);
  await exec(`truncate -s ${sizeGb}G ${LOOP_FILE}`);
  spinner.stop("Sparse file created");

  spinner.start("Setting up loop device");
  const { stdout: loopDev } = await exec(`losetup --find --show ${LOOP_FILE}`);
  spinner.stop(`Loop device: ${loopDev}`);

  spinner.start("Creating physical volume");
  await exec(`pvcreate -f ${loopDev}`);
  spinner.stop("Physical volume created");

  spinner.start(`Creating volume group '${LVM.VG_NAME}'`);
  await exec(`vgcreate ${LVM.VG_NAME} ${loopDev}`);
  spinner.stop("Volume group created");

  spinner.start("Creating thin pool (90% of VG)");
  await exec(`lvcreate -l 90%FREE -T ${LVM.VG_NAME}/${LVM.THIN_POOL}`);
  spinner.stop("Thin pool created");

  await setupLoopPersistence(loopDev);
}

async function setupLoopPersistence(loopDev: string) {
  const serviceContent = `[Unit]
Description=Setup loop device for sandbox thin pool
DefaultDependencies=no
Before=lvm2-activation.service
After=systemd-udevd.service

[Service]
Type=oneshot
ExecStart=/sbin/losetup ${loopDev} ${LOOP_FILE}
RemainAfterExit=yes

[Install]
WantedBy=local-fs.target
`;

  await Bun.write("/etc/systemd/system/sandbox-loop.service", serviceContent);
  await exec("systemctl daemon-reload");
  await exec("systemctl enable sandbox-loop.service");
}

async function setupWithDevice(spinner: ReturnType<typeof p.spinner>) {
  const device = await p.text({
    message: "Enter block device for sandbox storage:",
    placeholder: "/dev/nvme0n1p4",
    validate: (value: string) => {
      if (!value) return "Device path required";
      if (!value.startsWith("/dev/")) return "Must be a /dev/ path";
      return undefined;
    },
  });

  if (p.isCancel(device)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  await validateDevice(device);

  const confirm = await p.confirm({
    message: `This will DESTROY all data on ${device}. Continue?`,
    initialValue: false,
  });

  if (p.isCancel(confirm) || !confirm) {
    p.cancel("Aborted");
    process.exit(0);
  }

  spinner.start("Creating physical volume");
  await exec(`pvcreate -f ${device}`);
  spinner.stop("Physical volume created");

  spinner.start(`Creating volume group '${LVM.VG_NAME}'`);
  await exec(`vgcreate ${LVM.VG_NAME} ${device}`);
  spinner.stop("Volume group created");

  spinner.start("Creating thin pool (90% of VG)");
  await exec(`lvcreate -l 90%FREE -T ${LVM.VG_NAME}/${LVM.THIN_POOL}`);
  spinner.stop("Thin pool created");
}

async function destroyStorage() {
  const confirm = await p.confirm({
    message: "This will DELETE all sandbox volumes and data. Are you sure?",
    initialValue: false,
  });

  if (p.isCancel(confirm) || !confirm) {
    p.cancel("Aborted");
    return;
  }

  const spinner = p.spinner();
  spinner.start("Destroying storage");

  await exec(`lvremove -f ${LVM.VG_NAME}`, { throws: false });
  await exec(`vgremove -f ${LVM.VG_NAME}`, { throws: false });

  const { stdout: pvs } = await exec(`pvs --noheadings -o pv_name`, {
    throws: false,
  });
  for (const pv of pvs
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (pv.startsWith("/dev/loop")) {
      await exec(`pvremove -f ${pv}`, { throws: false });
      await exec(`losetup -d ${pv}`, { throws: false });
    }
  }

  if (await fileExists(LOOP_FILE)) {
    await exec(`rm -f ${LOOP_FILE}`);
  }

  await exec("systemctl disable sandbox-loop.service 2>/dev/null || true", {
    throws: false,
  });
  await exec("rm -f /etc/systemd/system/sandbox-loop.service", {
    throws: false,
  });

  spinner.stop("Storage destroyed");
}

async function showDiskLayout() {
  p.log.info("Current disk layout:");
  const { stdout } = await exec("lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT");
  console.log(stdout);
  console.log("");
}

async function showStorageStatus() {
  p.log.info("LVM Status:");

  const { stdout: vgs } = await exec(`vgs ${LVM.VG_NAME}`, { throws: false });
  if (vgs) console.log(vgs);

  const { stdout: lvs } = await exec(`lvs ${LVM.VG_NAME}`, { throws: false });
  if (lvs) console.log(lvs);

  console.log("");
  p.note(
    `Build image:      frak-sandbox images dev-base
Delete snapshot:  lvremove -f ${LVM.VG_NAME}/sandbox-{id}
List volumes:     lvs ${LVM.VG_NAME}`,
    "Usage",
  );
}

async function validateDevice(device: string) {
  const exists = await exec(`test -b ${device}`, { throws: false });
  if (!exists.success) {
    throw new Error(`Device not found or not a block device: ${device}`);
  }

  const mounted = await exec(`mount | grep "^${device}"`, { throws: false });
  if (mounted.success) {
    throw new Error(`Device is currently mounted: ${device}`);
  }

  const { stdout: sizeBytes } = await exec(`blockdev --getsize64 ${device}`);
  const sizeGb = Math.floor(Number(sizeBytes) / 1024 / 1024 / 1024);

  if (sizeGb < 10) {
    throw new Error(`Device too small: ${sizeGb}GB (minimum 10GB recommended)`);
  }

  p.log.info(`Device: ${device} (${sizeGb}GB)`);
}

async function testSnapshotPerformance(spinner: ReturnType<typeof p.spinner>) {
  spinner.start("Testing snapshot performance");

  const testSnap = `test-snapshot-${Date.now()}`;
  const startTime = performance.now();

  const sourceVolume = `${LVM.IMAGE_PREFIX}dev-base`;
  const sourceExists = await exec(`lvs ${LVM.VG_NAME}/${sourceVolume}`, {
    throws: false,
  });
  if (!sourceExists.success) {
    spinner.stop(
      "No image volume found — run 'frak-sandbox images dev-base' first",
    );
    return;
  }
  await exec(`lvcreate -s -n ${testSnap} ${LVM.VG_NAME}/${sourceVolume}`);

  const duration = Math.round(performance.now() - startTime);

  await exec(`lvremove -f ${LVM.VG_NAME}/${testSnap}`);

  let rating: string;
  if (duration < 50) {
    rating = "EXCELLENT";
  } else if (duration < 200) {
    rating = "GOOD";
  } else {
    rating = "SLOW";
  }

  spinner.stop(`Snapshot created in ${duration}ms (${rating})`);
}
