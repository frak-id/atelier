/** Plain stdout/stderr formatting helpers (non-interactive output). */
import pc from "picocolors";

export function fail(message: string): never {
  process.stderr.write(`${pc.red("atelier:")} ${message}\n`);
  process.exit(1);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

/** Colorize a sandbox/job status for at-a-glance scanning. */
export function statusColor(status: string): string {
  switch (status) {
    case "running":
    case "succeeded":
    case "ready":
      return pc.green(status);
    case "paused":
    case "queued":
    case "creating":
    case "building":
      return pc.yellow(status);
    case "error":
    case "failed":
    case "canceled":
      return pc.red(status);
    default:
      return pc.dim(status);
  }
}

/** Render aligned columns with a dim header row. Cells may contain ANSI color
 * (width is measured on the stripped string). */
export function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) return;
  const strip = (s: string): string =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI for width
    s.replace(/\u001b\[[0-9;]*m/g, "");
  const widths = headers.map((h, i) =>
    Math.max(strip(h).length, ...rows.map((r) => strip(r[i] ?? "").length)),
  );
  const pad = (cell: string, i: number): string =>
    cell + " ".repeat(Math.max(0, (widths[i] ?? 0) - strip(cell).length));
  line(headers.map((h, i) => pc.dim(pad(h, i))).join("  "));
  for (const row of rows) {
    line(headers.map((_, i) => pad(row[i] ?? "", i)).join("  "));
  }
}

/** Relative age like `3m`, `2h`, `5d` from an ISO timestamp. */
export function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
