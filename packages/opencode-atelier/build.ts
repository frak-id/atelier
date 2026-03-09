export {};

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  minify: false,
  external: ["zod", "@opencode-ai/plugin", "@opencode-ai/sdk"],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(`  ${output.path} (${output.size} bytes)`);
}
console.log("Build complete.");
