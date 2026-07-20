# @konfeature/atelier

The `atelier` CLI — a typed reference client for the [Atelier](https://github.com/frak-id/atelier) sandbox runtime and control API, built on [Eden Treaty](https://elysiajs.com/eden/overview.html).

## Install

```sh
npm install -g @konfeature/atelier
# or run without installing
npx @konfeature/atelier
```

Requires [Node.js](https://nodejs.org) >= 20.

## Getting started

```sh
# First run sets you up and drops you into the interactive cockpit. Choose to
# log in to a hosted server, paste an API key, or run a local server via Docker.
atelier

# Or log in explicitly
atelier login

# Configure the base URL + API key and check health
atelier config
```

### Local server via Docker

No hosted deployment? Boot one on your machine — it runs the `atelier-server`
image with the Docker runtime backend (sandboxes become sibling containers) and
points a `local` context at it:

```sh
atelier local up        # boot the server + wire the `local` context
atelier local status    # container + health
atelier local logs      # follow server logs
atelier local down      # stop + remove (add --volume to wipe state)
```

Host networking is first-class on Linux and OrbStack; on Docker Desktop pass
`atelier local up --network bridge`.

### Contexts (switch remote / local)

Each context is a `{ baseUrl, apiKey }` pair. Flip between a hosted server and a
local one without re-authing:

```sh
atelier context ls              # list contexts (active one marked *)
atelier context use default     # switch
atelier context add staging --url https://staging.example.com --key atl_…
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
