export interface AtelierConfig {
  managerUrl: string;
  apiKey?: string;
}

export interface SpawnResult {
  sandboxId: string;
  workspaceId: string;
  workspaceName: string;
  opencodeUrl: string;
  password?: string;
}

export class AtelierClient {
  constructor(private config: AtelierConfig) {}

  async spawn(remoteUrl: string, branch?: string): Promise<SpawnResult> {
    const res = await fetch(`${this.config.managerUrl}/api/opencode/spawn`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ remoteUrl, branch }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Atelier spawn failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<SpawnResult>;
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const res = await fetch(
      `${this.config.managerUrl}/api/sandboxes/${sandboxId}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Atelier destroy failed (${res.status})`);
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      h.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return h;
  }
}
