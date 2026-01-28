export async function exec(
  command: string,
  options?: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const cmd = new Deno.Command("sh", {
    args: ["-c", command],
    stdout: "piped",
    stderr: "piped",
    signal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined,
  });
  const output = await cmd.output();
  const decoder = new TextDecoder();
  return {
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

export function execSync(command: string): string {
  const cmd = new Deno.Command("sh", {
    args: ["-c", command],
    stdout: "piped",
    stderr: "piped",
  });
  const output = cmd.outputSync();
  return new TextDecoder().decode(output.stdout);
}
