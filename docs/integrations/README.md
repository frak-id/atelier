# Integrations

An integration links Atelier to an external agent UI (Steery today; the
opencode IDE and Orca later). Integrations are compiled into the server, the
operator switches each on through the environment, and each person connects
their own account in **Settings → Integrations**.

Per-integration guides: [steery.md](./steery.md).

## What it does

Atelier pushes an event to the UI, which may answer it. The only event today
is an agent **permission prompt** in an Atelier-driven session (console chat,
MCP tasks, Launchpad). The first answer wins, from the console or any
integration.

Using Atelier as a UI's remote compute needs no integration: the UI uses a
normal API key.

## The contract

`apps/server/src/integrations/integration.ts` is the contract. An
`Integration` is a `manifest` plus optional hooks:

- `manifest`: `id`, `label`, `description`, `docsUrl?`, `serverSettings?`
  (operator settings), `credential?` (a write-only credential the person gives
  when connecting: their key at the UI's service).
- `onPermission(request, ctx)?`: called for a prompt in a sandbox whose owner
  connected this integration and whose risk passed the connection's filter.
  Resolve when done; stop and withdraw what you raised once `ctx.signal`
  aborts; call `ctx.answer(optionId)` to answer (first answer wins, an id that
  was not offered is ignored). A throw is logged and the prompt stays pending
  for the console.

A hook is added to the contract only together with its first caller and a test.

## Adding one

1. Create `apps/server/src/integrations/<id>/` exporting an `Integration`.
   The id matches `/^[a-z][a-z0-9-]{1,30}$/`.
2. Add one import and one entry to `INTEGRATIONS` in
   `integrations/catalog.ts`.
3. Add colocated tests (the hook with an injectable `fetch`/clock, no network).
4. Document it in `docs/integrations/<id>.md`.

The console needs no change: the Integrations page renders from the manifest.

## Enabling (operator)

Environment, read once at boot. Never over the API: an API-editable value
could repoint where people's credentials are sent.

| Variable | Meaning |
|----------|---------|
| `ATELIER_INTEGRATION_<ID>` | `true` or `1` turns the integration on; anything else or unset is off |
| `ATELIER_INTEGRATION_<ID>_<NAME>` | A `serverSettings` value; defaults fill gaps |

`<ID>` is the id upper-cased with `-` replaced by `_`; `<NAME>` is the
camelCase setting name in UPPER_SNAKE (`url` → `URL`). A `url` setting must be
an absolute http(s) URL, https in production. The server refuses to boot on a
bad id or setting name, colliding environment names, or an invalid URL of an
enabled integration. A disabled integration is invisible: not listed, its
connections never notified.

## Connecting (person)

Settings → Integrations lists the enabled integrations:

- **Connect**: the credential (when the manifest declares one; stored
  encrypted, never shown again), and, for integrations that take permission
  prompts, the minimum risk (`low`/`medium`/`high`, default `high`) and a delay
  in seconds (default 0).
- **Edit**: the credential is never prefilled; type to replace, or clear it
  when optional. A connection can be paused: that only stops permission
  routing.
- **Disconnect**: deletes the credential.

API: `GET /api/integrations`, `PUT|DELETE /api/integrations/:id/connection`.
Connecting needs an enabled integration; disconnecting also works for a
disabled one, to clean up leftovers.

## Owner-only routing

A permission prompt goes to the **sandbox owner's** connections, even when an
org member is driving the sandbox (that member pings the owner). A sandbox
without an owner notifies nobody. The console always keeps the prompt open.

## The boundary rule

Enforced by `bun run --filter @atelier/server check:boundary`:
`integrations/` never imports `control/`, `sessions/` or `runtime/`; a vendor
directory `integrations/<id>/` imports only `../integration.ts`, `shared/` and
workspace packages; only `catalog.ts` imports a vendor directory. Whatever an
integration needs from the server arrives as hook arguments, wired in
`api/container.ts`.
