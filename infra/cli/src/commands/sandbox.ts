import * as p from "@clack/prompts";
import { LVM } from "../lib/context";
import { exec } from "../lib/shell";

export async function sandbox(args: string[] = []) {
  const subcommand = args[0];

  switch (subcommand) {
    case "resize":
      await resizeSandbox(args.slice(1));
      break;
    case "list":
      await listSandboxVolumes();
      break;
    default:
      await sandboxMenu();
  }
}

async function sandboxMenu() {
  const action = await p.select({
    message: "Sandbox management",
    options: [
      {
        value: "resize",
        label: "Resize Sandbox",
        hint: "Extend storage for a running sandbox",
      },
      {
        value: "list",
        label: "List Volumes",
        hint: "Show all sandbox LVM volumes",
      },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  switch (action) {
    case "resize":
      await resizeSandbox([]);
      break;
    case "list":
      await listSandboxVolumes();
      break;
  }
}

async function listSandboxVolumes() {
  const spinner = p.spinner();
  spinner.start("Listing sandbox volumes");

  const result = await exec(
    `lvs ${LVM.VG_NAME} -o lv_name,lv_size,data_percent,origin --noheadings`,
    { throws: false },
  );

  spinner.stop("Volumes retrieved");

  if (!result.success) {
    p.log.error("Failed to list volumes");
    return;
  }

  const lines = result.stdout.trim().split("\n");
  const sandboxVolumes = lines.filter((line) =>
    line.trim().startsWith("sandbox-"),
  );

  if (sandboxVolumes.length === 0) {
    p.log.info("No sandbox volumes found");
    return;
  }

  console.log("");
  console.log("  Volume                  Size      Used%   Origin");
  console.log("  ──────────────────────────────────────────────────────");

  for (const line of sandboxVolumes) {
    const [name, size, used, origin] = line.trim().split(/\s+/);
    const sandboxId = name?.replace("sandbox-", "") || "";
    console.log(
      `  ${sandboxId.padEnd(22)}  ${(size || "-").padEnd(8)}  ${(used || "-").padEnd(6)}  ${origin || "-"}`,
    );
  }
  console.log("");
}

async function resizeSandbox(args: string[]) {
  let sandboxId = args[0];
  let newSizeGb = args[1] ? parseInt(args[1], 10) : undefined;

  if (!sandboxId) {
    const spinner = p.spinner();
    spinner.start("Finding running sandboxes");

    const result = await exec(
      `lvs ${LVM.VG_NAME} -o lv_name,lv_size --noheadings`,
      { throws: false },
    );

    spinner.stop("Sandboxes found");

    if (!result.success) {
      p.log.error("Failed to list volumes");
      return;
    }

    const lines = result.stdout.trim().split("\n");
    const sandboxVolumes = lines
      .filter((line) => line.trim().startsWith("sandbox-"))
      .map((line) => {
        const [name, size] = line.trim().split(/\s+/);
        return {
          id: name?.replace("sandbox-", "") || "",
          size: size || "unknown",
        };
      });

    if (sandboxVolumes.length === 0) {
      p.log.error("No sandbox volumes found");
      return;
    }

    const selected = await p.select({
      message: "Select sandbox to resize",
      options: sandboxVolumes.map((v) => ({
        value: v.id,
        label: v.id,
        hint: `Current size: ${v.size}`,
      })),
    });

    if (p.isCancel(selected)) {
      p.cancel("Cancelled");
      process.exit(0);
    }

    sandboxId = selected;
  }

  const volumeName = `sandbox-${sandboxId}`;
  const volumePath = `${LVM.VG_NAME}/${volumeName}`;

  const currentSizeResult = await exec(
    `lvs ${volumePath} -o lv_size --noheadings --units g --nosuffix`,
    { throws: false },
  );

  if (!currentSizeResult.success) {
    p.log.error(`Sandbox volume not found: ${sandboxId}`);
    return;
  }

  const currentSizeGb = Math.round(parseFloat(currentSizeResult.stdout.trim()));
  p.log.info(`Current size: ${currentSizeGb}GB`);

  if (!newSizeGb) {
    const sizeInput = await p.text({
      message: "New size in GB?",
      placeholder: String(currentSizeGb + 5),
      validate: (value) => {
        const num = parseInt(value, 10);
        if (Number.isNaN(num)) return "Must be a number";
        if (num <= currentSizeGb)
          return `Must be larger than current size (${currentSizeGb}GB)`;
        if (num > 100) return "Maximum 100GB";
        return undefined;
      },
    });

    if (p.isCancel(sizeInput)) {
      p.cancel("Cancelled");
      process.exit(0);
    }

    newSizeGb = parseInt(sizeInput, 10);
  }

  if (newSizeGb <= currentSizeGb) {
    p.log.error(
      `New size (${newSizeGb}GB) must be larger than current (${currentSizeGb}GB)`,
    );
    return;
  }

  const spinner = p.spinner();

  spinner.start(`Extending volume to ${newSizeGb}GB`);
  const extendResult = await exec(`lvextend -L ${newSizeGb}G ${volumePath}`, {
    throws: false,
  });

  if (!extendResult.success) {
    spinner.stop("Volume extension failed");
    p.log.error(extendResult.stderr || "Unknown error");
    return;
  }
  spinner.stop("Volume extended");

  p.log.success(`Volume resized: ${currentSizeGb}GB → ${newSizeGb}GB`);
  p.note(
    `The filesystem inside the VM needs to be expanded.
Either:
  1. Use the API: POST /sandboxes/{id}/storage/resize
  2. SSH into the VM and run: sudo resize2fs /dev/vda`,
    "Next Steps",
  );
}
