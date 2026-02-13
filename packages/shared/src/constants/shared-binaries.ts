export const OPENCODE = {
  RELEASE_URL: "https://github.com/anomalyco/opencode/releases/download",
  BINARY: "opencode-linux-x64-baseline.tar.gz",
} as const;

export const CODE_SERVER = {
  RELEASE_URL: "https://github.com/coder/code-server/releases/download",
} as const;

export type SharedBinaryId = "opencode" | "code-server";

export interface SharedBinaryInfo {
  name: string;
  version: string;
  url: string;
  extractCommand: string;
  binaryPath: string;
  estimatedSizeMb: number;
}

interface VersionOverrides {
  opencode?: string;
  codeServer?: string;
}

export function getSharedBinaries(
  overrides: VersionOverrides = {},
): Record<SharedBinaryId, SharedBinaryInfo> {
  const ocVersion = overrides.opencode ?? "1.1.65";
  const csVersion = overrides.codeServer ?? "4.108.2";

  return {
    opencode: {
      name: "opencode",
      version: ocVersion,
      url: `${OPENCODE.RELEASE_URL}/v${ocVersion}/${OPENCODE.BINARY}`,
      extractCommand: "tar -xzf",
      binaryPath: "opencode",
      estimatedSizeMb: 100,
    },
    "code-server": {
      name: "code-server",
      version: csVersion,
      url: `${CODE_SERVER.RELEASE_URL}/v${csVersion}/code-server-${csVersion}-linux-amd64.tar.gz`,
      extractCommand: "tar -xzf",
      binaryPath: `code-server-${csVersion}-linux-amd64`,
      estimatedSizeMb: 500,
    },
  };
}
