/**
 * Operator commands, run next to the hub's config:
 *
 *   bun run src/cli.ts token                          mint a bearer token
 *   bun run src/cli.ts index <dir> --repo o/n [--revision sha] [--files]
 *                                                     index a local checkout
 *   bun run src/cli.ts search <query…> [--audience org,user:x]
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { applyIndex, indexRepository } from "@atelier/knowledge";
import { mintToken } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { createHubServices } from "./services.ts";

async function gitHead(dir: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 ? out : undefined;
}

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    revision: { type: "string" },
    files: { type: "boolean", default: false },
    audience: { type: "string", default: "org" },
  },
});
const [command, ...rest] = positionals;

switch (command) {
  case "token": {
    const { token, sha256 } = mintToken();
    console.log(`token:  ${token}\nsha256: ${sha256}\n`);
    console.log("Add to hub.config.json → tokens:");
    console.log(
      JSON.stringify(
        {
          name: "my-token",
          sha256,
          actor: { kind: "human", id: "user:me" },
          scopes: ["read", "propose", "review", "index"],
          audience: ["user:me"],
        },
        null,
        2,
      ),
    );
    break;
  }
  case "index": {
    const dir = resolve(rest[0] ?? ".");
    if (!values.repo) throw new Error("--repo owner/name is required");
    const revision = values.revision ?? (await gitHead(dir)) ?? "local";
    const hub = createHubServices(loadConfig());
    const index = await indexRepository({
      root: dir,
      repo: values.repo,
      revision,
      includeFiles: values.files,
    });
    const report = applyIndex(index, {
      graph: hub.graph,
      documents: hub.documents,
    });
    const embedded = await hub.search.embedPending();
    console.log(JSON.stringify({ report, embedded, index: index.stats }));
    for (const w of index.warnings) console.warn(`warning: ${w}`);
    break;
  }
  case "search": {
    const hub = createHubServices(loadConfig());
    const hits = await hub.search.search({
      text: rest.join(" "),
      audience: (values.audience ?? "org").split(","),
      limit: 10,
    });
    for (const h of hits) {
      console.log(`${h.score.toFixed(4)}  [${h.kind}] ${h.title}  (${h.id})`);
      console.log(`         ${h.snippet.replaceAll("\n", " ")}`);
    }
    break;
  }
  default:
    console.error("usage: cli.ts token | index <dir> --repo o/n | search <q>");
    process.exit(1);
}
