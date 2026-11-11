# Service accounts

A service account is a non-human Atelier user for agents and CI. It has its
own API keys, owns the sandboxes it creates and pushes to GitHub with its own
credential. Without one, an agent has to use a person's API key: it then acts
as that person, its sandboxes get that person's GitHub token, and the key often
belongs to a server admin.

Server admins manage service accounts in **Settings > Service accounts** or
over `/api/service-accounts`. They can also be declared in
`sandbox.config.json`.

## What a service account is

- A user of kind `service`. Its id is `sa_…` and its username is `<name>[bot]`.
  Brackets are invalid in a GitHub login, so the name never collides with a
  person who signs in later.
- A member of exactly one org. Its role defaults to `member`. It is a server
  admin only if an admin makes it an `owner` of the default org.
- It cannot sign in to the console. It authenticates with API keys only, and
  only admins create and revoke them. A service account's key gets 403 on
  `/api/api-keys`, `/api/ssh-keys` and org creation, and on every admin route
  unless an admin made it one.
  Its org membership changes only through the service-account routes: the
  regular member routes refuse to invite, change or remove it.
- It can use toolboxes but never creates what runs in other people's
  sandboxes. It gets 403, even as an admin with a `full` key, on toolbox
  create, update, delete, pin and publish, on toolset build and publish, on
  changing a prebuild's dev servers, and on base image build and register
  (HTTP and the `/mcp/admin` tools alike).
- In local mode it is not an admin and reaches only its own sandboxes. It
  never uses the host's `ATELIER_GITHUB_TOKEN`. It sees and cancels only its
  own jobs.
- It owns the sandboxes it creates (`atelier.dev/owner-id` is its id). They
  carry `atelier.dev/owner-kind: service`, and the console marks them with a
  "service" badge.

### Which sandboxes it can reach

| Caller | Sandboxes it can reach |
|--------|------------------------|
| A service account | Only the ones it owns |
| A person in the account's org | The account's sandboxes (org rule) and the rest of the org's |
| A server admin | Every sandbox owned by a service account, in any org |

A service account never reaches another member's sandbox, even in its own org.
A person's sandbox holds that person's GitHub token, and an agent that could
exec into it could read it.

Org membership still gives the account what any member gets: the org's
secrets are resolved into its sandboxes, and it can use the org's toolboxes.
It can also use every prebuild, as a person can. Prebuilds aren't scoped to
an org, so it lists and boots all of them, whoever baked them.

**Warning: the account gets every secret of its org, by name.** An agent that
can name a secret (`{"$secret": "NAME"}` in a sandbox's `env`) gets its value.
Put an agent in its own org that holds only the secrets it needs, not in the
default org.

### What people run from an agent's work

Prebuilds are shared by everyone. A person who asks for a repo boots the
newest bake of it, whoever baked it, with its recorded processes. Their own
GitHub token is written in at boot. A service account's bake can therefore run
agent-chosen code with a person's token.

Forking a service account's sandbox, or booting one of its snapshots, gives
the person a copy of the agent's disk (dotfiles, `.git/hooks`, binaries) and
spec (processes, hooks, files). It runs with the person's token.

Treat an agent's sandboxes, snapshots and bakes as untrusted. Take its work
through git (a branch and a pull request), or work inside its sandbox, which
only holds the agent's credential. These are known gaps (see the roadmap).

## API keys and scopes

Every API key has a scope:

| Scope | Works on |
|-------|----------|
| `full` | Every authenticated route, `/mcp` and `/mcp/admin` (if the user is an admin) |
| `mcp` | `/mcp` only. `/mcp/admin` and the HTTP API answer 403 |

Keys an admin creates for a service account default to `mcp`. Personal keys
(Settings > API Keys) default to `full`, and a person can create an `mcp` key
for a tool that only needs the sandbox MCP.

## GitHub credentials

A service account's sandboxes, prebuilds and prebuild staleness checks use the
account's own credential, never a person's token (local mode's
`ATELIER_GITHUB_TOKEN` included). There are two kinds.

### GitHub App (preferred)

1. Create a GitHub App owned by your org. It needs no webhook. Grant the
   repository permissions sandboxes need: **Contents** (write),
   **Pull requests** (write), **Workflows** (write, to push changes under
   `.github/workflows/`) and **Metadata** (read).
2. Generate a private key and install the App on the repositories the agent
   may push to.
3. Note the App ID (App settings) and the installation ID (the number at the
   end of the installation's settings URL).
4. Give them to the service account, with the private key, in the console or
   in the config (below).

Atelier mints a one-hour installation token whenever it needs one: at every
boot (create, resume, fork), for prebuild bakes and for the staleness check.
Tokens are cached and minted again 15 minutes before they expire. If a mint
fails while the cached token still has more than 2 minutes left, that token is
used. A credential that was edited, removed or deleted drops its cached token,
and a removed or deleted one is also revoked at GitHub (best effort).

Each token is narrowed to:

- the permissions you list (`permissions`), or by default `contents`,
  `pull_requests` and `workflows` write and `metadata` read, intersected with
  what the installation was granted, so the request never asks for more than
  the App has;
- the repositories you list (`repositories`, bare names in the
  installation's account), or every repository of the installation when you
  omit it. An empty list is refused. The list limits what the token can
  clone, fetch and push. It doesn't limit which prebuilds the account boots.

Commits are authored as the App's bot user, `<app-slug>[bot]` with the email
`<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`. GitHub then shows the
pushes as the App's, so a person can approve the agent's pull requests.

**Running sandboxes.** A token lasts an hour and sandboxes run longer. Every 5
minutes the server rewrites `/etc/gitconfig` and
`/etc/sandbox/secrets/git-credentials` in each running service-account sandbox
whose token or git identity changed. A new token therefore reaches a running
sandbox at the next 5-minute tick. The write does not count as activity, so
idle auto-pause still applies. If a mint fails, or the stored secret can't be
decrypted (for example a wrong `SANDBOX_SECRETS_KEY`), the previous token
stays and the next tick tries again. Only an account with no credential gets
an empty credential file. GitHub calls time out after 10 seconds.

**Test connection** (console, or `POST
/api/service-accounts/:id/github/check`) mints a token and shows the bot
identity, the token's expiry, its permissions and repositories, or GitHub's
error. It reads the installation's permissions fresh, not from the 10-minute
cache.

### Static token (fallback)

A token such as a machine account's fine-grained personal access token, with
the git name and email to commit as. It is simpler to set up, but it lives as
long as you let it and you rotate it by hand. An edited token reaches running
sandboxes within 5 minutes; a removed credential empties their credential
file.

### What the sandbox can do with it

The credential file is readable by `dev`, the user the coding agent runs as,
and sandbox egress is open. Anything the agent runs can read the token and
send it out. Keep the App's installation and permissions as narrow as the work
needs: an installation token expires within the hour, a static token does not.

## Declaring service accounts in the config

```jsonc
{
  "serviceAccounts": [
    {
      "name": "coding-agent",
      "org": "agents",             // org slug; must exist
      "role": "member",            // default
      "description": "Agents behind our MCP gateway",
      "github": {
        "appId": "123456",
        "installationId": "7890123",
        "privateKeyEnv": "CODING_AGENT_GITHUB_APP_KEY", // or "privateKeyFile": "/etc/atelier/coding-agent.pem"
        "repositories": ["my-repo"],                // optional
        "permissions": { "contents": "write", "pull_requests": "write" } // optional
      },
      "apiKey": { "env": "CODING_AGENT_API_KEY", "scope": "mcp" }
    }
  ]
}
```

A static token instead of an App:
`"github": { "tokenEnv": "CODING_AGENT_GITHUB_TOKEN", "gitName": "my-bot",
"gitEmail": "bot@example.com" }`.

Secrets never go in the file. The App private key comes from `privateKeyEnv`
or `privateKeyFile` (exactly one), a static token from `tokenEnv`, and the
account's API key from `apiKey.env`. Generate the API key once and give the
same value to the server and to your gateway:

```bash
echo "atl_$(openssl rand -hex 24)"
```

It must start with `atl_` followed by at least 32 characters from
`[A-Za-z0-9_-]`. Atelier stores only its hash.

The server reads the env vars and the config file once, at process start. A
changed API key or token env var, or an edited `serviceAccounts` list, applies
on restart. The reconcile also runs every 5 minutes: that pass picks up an org
created since, and a changed `privateKeyFile`. It does the following:

- It creates the account, or adopts a console-made account with the same
  name, and sets its description, org and role.
- It stores the GitHub credential read from the environment or the key file.
  An entry without `github` removes the stored credential.
- It keeps exactly one config-managed API key whose hash matches `apiKey.env`.
  Changing the env value and restarting rotates the key.
- If the org doesn't exist yet, the account is skipped with a warning and
  created on a later pass. A fresh install creates the default org at the
  first sign-in.
- An account removed from the list becomes console-managed, and its
  config-managed key is revoked.

Config-managed accounts are read-only in the console. Admins can still add and
revoke other keys on them; the config key can't be revoked there.

In production, an unset env var, an unreadable key file or a malformed API key
stops the server at startup. Outside production a warning is logged and the
account keeps the secret it already has. A new account whose secret is missing
is created with no credential and no key. An empty `repositories` list is a
config error. A problem that persists is logged once, not every pass.

## Deleting a service account

Destroy its sandboxes first: deletion answers 409 while it still owns some, or
while it is still creating one. Server admins can see and destroy every
service-account sandbox. Deleting the account revokes its keys, removes its
membership and drops (and revokes) its cached token. Prebuilds it created stay.
Their staleness check then has no credential, so a prebuild of a private repo
is no longer refreshed.

## API

All routes need a server admin's session or `full` key.

| Route | Purpose |
|-------|---------|
| `GET /api/service-accounts` | List, with role, org and sandbox count |
| `POST /api/service-accounts` | Create: `{ name, description?, orgId, role?, github? }` |
| `GET`, `PATCH`, `DELETE /api/service-accounts/:id` | Read, update (`github: null` removes the credential; an omitted secret keeps the stored one), delete |
| `GET`, `POST /api/service-accounts/:id/api-keys` | List keys; create `{ name, expiresAt?, scope? }`, which returns the raw key once |
| `DELETE /api/service-accounts/:id/api-keys/:keyId` | Revoke a key |
| `POST /api/service-accounts/:id/github/check` | Test the App credential |

`github` is `{ "kind": "app", appId, installationId, privateKey?,
repositories?, permissions? }` or `{ "kind": "token", token?, gitName,
gitEmail }`. Responses never contain the private key or the token.
