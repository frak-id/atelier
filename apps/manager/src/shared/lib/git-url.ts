export function normalizeGitUrl(url: string): string {
  let normalized = url.trim();

  // SCP-style: git@host:path → host/path
  const scpMatch = normalized.match(/^[\w.-]+@([^:]+):(.+)$/);
  if (scpMatch?.[1] && scpMatch[2]) {
    normalized = `${scpMatch[1]}/${scpMatch[2]}`;
  } else {
    normalized = normalized.replace(/^(?:https?|ssh|git):\/\//, "");
    normalized = normalized.replace(/^[^@]+@/, "");
  }

  normalized = normalized.replace(/\.git$/, "");
  normalized = normalized.replace(/\/+$/, "");
  normalized = normalized.toLowerCase();

  return normalized;
}
