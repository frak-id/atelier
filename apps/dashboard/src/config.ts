interface RuntimeConfig {
  sshHostname: string;
  sshPort: number;
  opencodePort: number;
}

let loadedConfig: RuntimeConfig | null = null;

export async function loadConfig(): Promise<void> {
  if (loadedConfig) return;

  if (import.meta.env.DEV) {
    loadedConfig = {
      sshHostname: "ssh.localhost",
      sshPort: 2222,
      opencodePort: 3000,
    };
    return;
  }

  const response = await fetch("/config");
  if (!response.ok) {
    throw new Error(`Failed to load config: ${response.status}`);
  }
  loadedConfig = await response.json();
}

function assertLoaded(): RuntimeConfig {
  if (!loadedConfig) {
    throw new Error("Config not loaded. Call loadConfig() in main.tsx first.");
  }
  return loadedConfig;
}

export const config = {
  get sshHostname() {
    return assertLoaded().sshHostname;
  },
  get sshPort() {
    return assertLoaded().sshPort;
  },
  get opencodePort() {
    return assertLoaded().opencodePort;
  },
};
