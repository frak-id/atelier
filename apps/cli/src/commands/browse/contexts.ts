/** Cockpit context switching + the auth-mode probe that gates the local-only
 * GitHub-auth panel. */
import pc from "picocolors";
import type { AtelierApi } from "../../client.ts";
import { currentContext, listContexts, useContext } from "../../config.ts";
import { maskKey } from "../../output.ts";
import * as ui from "../../ui.ts";
import { BACK } from "./common.ts";

/** Does the server bypass auth (local/mock)? Gates the GitHub-auth panel — a
 * public, best-effort probe (any failure just hides it). */
export async function isBypassed(api: AtelierApi): Promise<boolean> {
  try {
    const res = await api.auth.mode.get();
    return Boolean(res.data?.bypassed);
  } catch {
    return false;
  }
}

/** List contexts and switch the active one (the cockpit twin of `context ls`
 * + `use`). Returns true when the active context changed, so the caller can
 * rebuild its client. */
export async function contextsMenu(): Promise<boolean> {
  const rows = listContexts();
  if (rows.length === 0) {
    ui.note("No contexts. Run `atelier login` or `atelier local up`.");
    return false;
  }
  const current = currentContext();
  const choice = await ui.select<string | typeof BACK>({
    message: "Switch context",
    options: [
      ...rows.map((r) => ({
        value: r.name,
        label: `${r.current ? pc.green("●") : " "} ${r.current ? pc.bold(r.name) : r.name}`,
        hint: `${r.baseUrl || pc.dim("(unset)")} · ${maskKey(r.apiKey)}`,
      })),
      { value: BACK, label: pc.dim("Back") },
    ],
  });
  if (choice === BACK || choice === current) return false;
  try {
    useContext(choice as string);
    ui.note(`Switched to ${pc.bold(choice as string)}`);
    return true;
  } catch (err) {
    ui.note(err instanceof Error ? err.message : String(err));
    return false;
  }
}
