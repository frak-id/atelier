# @atelier/cli

The `atelier` CLI — a typed reference client for the [Atelier](https://github.com/frak-id/atelier) sandbox runtime and control API, built on [Eden Treaty](https://elysiajs.com/eden/overview.html).

## Install

```sh
npm install -g @atelier/cli
# or run without installing
npx @atelier/cli
```

Requires Node.js >= 18.

## Getting started

```sh
# First run sets you up (browser login) and drops you into the interactive cockpit
atelier

# Or log in explicitly
atelier login

# Configure the base URL + API key and check health
atelier config
```

## Usage

```sh
atelier up            # Create a sandbox from a spec, snapshot, or image
atelier ps            # List sandboxes
atelier get <id>      # Show a sandbox's status, processes, and URLs
atelier exec <id> -- <cmd>   # Run a command in a sandbox
atelier ssh <id>      # SSH into a sandbox
atelier rm <id>       # Destroy a sandbox
```

Pass `--json` to any command for machine-readable output. Run `atelier --help` for the full command list.

## License

MIT © KONFeature
