# Setup (Debian + KVM)

## Requirements

- Debian (tested on 12/bookworm) with systemd
- x86_64 CPU with virtualization enabled
- `/dev/kvm` available (bare metal)
- Wildcard DNS for sandbox subdomains
- Ports `80` and `443` open
- Port `2222` open for SSH proxy access

## Install

Must be run as root.

```bash
curl -fsSL https://raw.githubusercontent.com/frak-id/oc-sandbox/main/infra/scripts/install.sh | sudo bash
```

Optional: set `ATELIER_VERSION=vX.Y.Z` to pin CLI version.

The installer prompts for:

- Domain suffix
- Dashboard domain
- SSH proxy domain
- TLS email for automatic HTTPS
- GitHub Client ID
- GitHub Client Secret
- Allowed GitHub org (optional)
- Allowed GitHub users (comma-separated, optional)
- JWT secret (auto-generated)

Set the Authorization callback URL in your GitHub OAuth App to `https://<dashboard-domain>/auth/callback`

## Config Location

By default, the config is read from:

```
/etc/atelier/sandbox.config.json
```

You can override this with `ATELIER_CONFIG=/path/to/sandbox.config.json`.

If no config exists (or you choose not to use the existing one), it writes `/etc/atelier/sandbox.config.json`, runs the full setup,
downloads the server bundle, and can build the base image.

## Post‑Install

`atelier init` will prompt to set up LVM thin provisioning (recommended). Skipping prevents image builds and LVM-based snapshots.

After storage setup, build the base image:

```bash
atelier images dev-base
```

Check manager health:

```bash
atelier manager status
```

## Update

```bash
atelier update
```

If the agent changed, the CLI will prompt to rebuild the base image.

## Manual TLS

For manual TLS, set `domain.tls.certPath` and `domain.tls.keyPath` in config.

## Optional: Preconfigure Storage

If you add `setup.storage` to `/etc/atelier/sandbox.config.json`, the CLI
will skip storage method selection during `atelier init` (it may still prompt for missing details like device or size). Example:

```json
{
  "setup": {
    "storage": {
      "method": "loop",
      "loopSizeGb": 100
    }
  }
}
```

You can also preconfigure network behavior (used by `atelier init`):

```json
{
  "setup": {
    "network": {
      "onExists": "status"
    }
  }
}
```

## Troubleshooting

- **No `/dev/kvm`**: ensure virtualization is enabled and use bare‑metal.
- **Caddy not issuing certs**: confirm DNS wildcard and open ports 80/443. Check logs: `journalctl -u caddy -n 200 --no-pager`
- **Manager unhealthy**: `journalctl -u atelier-manager -n 200 --no-pager`
