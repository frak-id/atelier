/** The cockpit's Base-images panel: list images, build/rebuild from a seed
 * template, and stream/read build logs. */
import pc from "picocolors";
import { type AtelierApi, type ImageRow, unwrap } from "../../client.ts";
import { line, printLogDelta, statusColor } from "../../output.ts";
import * as ui from "../../ui.ts";
import { BACK } from "./common.ts";

const imageIcon = (status: string): string =>
  status === "ready"
    ? pc.green("✓")
    : status === "error"
      ? pc.red("✗")
      : pc.yellow("…");

/** Poll an image build's log endpoint, streaming new lines until it settles. */
async function streamImageBuild(api: AtelierApi, name: string): Promise<void> {
  line(pc.dim(`building ${name} — this can take a while`));
  let printed = 0;
  while (true) {
    let res: { status: string; log: string };
    try {
      res = unwrap(await api.v1.images({ name }).logs.get());
    } catch {
      break;
    }
    printed = printLogDelta(res.log, printed);
    if (res.status !== "building") {
      line(
        res.status === "ready"
          ? pc.green(`✓ ${name} ready`)
          : pc.red(`✗ ${name} ${res.status}`),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Build (or force-rebuild) a base image from an embedded seed template. */
async function buildImageFlow(
  api: AtelierApi,
  images: ImageRow[],
): Promise<void> {
  const templates = unwrap(await api.v1.images.templates.get());
  if (templates.length === 0) {
    ui.note("No seed templates available on this server.");
    return;
  }
  const built = new Set(
    images
      .filter((i) => i.provenance === "seed")
      .map((i) => i.seedId ?? i.name),
  );
  const seed = await ui.select<string | typeof BACK>({
    message: "Build which base image?",
    options: [
      ...templates.map((t) => ({
        value: t.id,
        label: t.id,
        hint: [
          t.description,
          t.dependsOn.length ? `needs ${t.dependsOn.join(",")}` : "",
          built.has(t.id) ? pc.green("built") : "",
        ]
          .filter(Boolean)
          .join(" · "),
      })),
      { value: BACK, label: pc.dim("Back") },
    ],
  });
  if (seed === BACK) return;
  let force = false;
  if (built.has(seed as string)) {
    const yes = await ui.confirm({
      message: `${seed} is already built — rebuild from scratch?`,
      initialValue: true,
    });
    if (!yes) return;
    force = true;
  }
  const record = unwrap(
    await api.v1.images.post({ seed: seed as string, force }),
  );
  await streamImageBuild(api, record.name);
}

/** Base-image panel: list images, then build/rebuild from a seed or read a
 * build log. */
export async function imagesMenu(api: AtelierApi): Promise<void> {
  while (true) {
    const s = ui.spinner();
    s.start("Loading images…");
    let images: ImageRow[];
    try {
      images = unwrap(await api.v1.images.get());
      s.stop(`${images.length} image(s)`);
    } catch (err) {
      s.stop("Failed to load images");
      ui.note(err instanceof Error ? err.message : String(err));
      return;
    }
    ui.note(
      images.length > 0
        ? images
            .map(
              (i) =>
                `${imageIcon(i.status)} ${i.name}  ${pc.dim(i.provenance)}  ${pc.dim(i.ref ?? "")}`,
            )
            .join("\n")
        : pc.dim("none built yet"),
      "base images",
    );
    const action = await ui.select<"build" | "logs" | "refresh" | "back">({
      message: "Base images",
      options: [
        {
          value: "build",
          label: "Build / rebuild an image",
          hint: "from an embedded seed template",
        },
        ...(images.length > 0
          ? [{ value: "logs" as const, label: "View a build log" }]
          : []),
        { value: "refresh", label: pc.dim("Refresh") },
        { value: "back", label: pc.dim("Back") },
      ],
    });
    if (action === "back") return;
    if (action === "refresh") continue;
    if (action === "build") {
      await buildImageFlow(api, images);
      continue;
    }
    // logs
    const name = await ui.select<string | typeof BACK>({
      message: "Log for which image?",
      options: [
        ...images.map((i) => ({
          value: i.name,
          label: i.name,
          hint: i.status,
        })),
        { value: BACK, label: pc.dim("Back") },
      ],
    });
    if (name === BACK) continue;
    const img = images.find((i) => i.name === name);
    if (img?.status === "building") {
      await streamImageBuild(api, name as string);
    } else {
      const res = unwrap(
        await api.v1.images({ name: name as string }).logs.get(),
      );
      line(`status: ${statusColor(res.status)}`);
      if (res.log) line(pc.dim(res.log.trimEnd()));
    }
  }
}
