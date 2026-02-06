# L'atelier (oc-sandbox)

Firecracker‑based, self‑hosted sandboxes with fast boot, strong isolation, and a simple CLI.

**Status:** Debian 12 + KVM + x86_64

## Quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/frak-id/oc-sandbox/main/infra/scripts/install.sh | bash
```

After install:

```bash
atelier manager status
```

## Requirements

- Debian 12 (systemd)
- Bare‑metal KVM (`/dev/kvm` present)
- x86_64 CPU
- A real domain with wildcard DNS:
  - `*.your-domain.com` → server IP
- Ports `80` and `443` open for HTTPS

## Key Commands

- `atelier init` – full install (config + setup + update + images)
- `atelier update` – download + install server bundle
- `atelier images build dev-base` – build base image
- `atelier manager status` – manager health

## Configuration

Default config path: `/etc/atelier/sandbox.config.json`  
Override with `ATELIER_CONFIG=/path/to/sandbox.config.json`

If you pre‑fill `setup.storage` or `setup.network` in the config, the CLI will
skip prompts during `atelier init`.

## Docs

- Setup guide: `docs/setup.md`
- Infrastructure details: `docs/infrastructure.md`

## Contributing

See `CONTRIBUTING.md` for development setup and PR guidelines.

## Security

See `SECURITY.md` for vulnerability reporting.
