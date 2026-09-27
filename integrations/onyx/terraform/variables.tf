# --- Onyx connection -------------------------------------------------------

variable "onyx_url" {
  type        = string
  description = "Onyx server origin, e.g. https://onyx.hetzner-staging.frak.id."
  default     = "https://onyx.hetzner-staging.frak.id"
}

variable "onyx_api_key" {
  type        = string
  sensitive   = true
  description = <<-EOT
    Bootstrap Onyx API key ("on_...") created by hand in the admin UI
    (Settings -> API Keys) after the first-user-becomes-admin signup. See
    README "Setup" step 2 — this is the one manual secret that must exist
    before Terraform can run at all.
  EOT
}

# --- LLM (cliproxy) ----------------------------------------------------------

variable "llm_base_url" {
  type        = string
  description = "OpenAI-compatible base URL for the in-cluster cliproxy."
  default     = "http://atelier-cliproxy.atelier-system.svc.cluster.local:8317/v1"
}

variable "llm_api_key" {
  type        = string
  sensitive   = true
  description = "Bearer token cliproxy expects on /v1/chat/completions."
}

variable "llm_model" {
  type        = string
  description = "Default model id served by cliproxy."
  default     = "claude-sonnet-5"
}

variable "llm_provider" {
  type        = string
  description = <<-EOT
    LiteLLM provider key Onyx registers cliproxy under. cliproxy exposes an
    OpenAI-compatible /v1/chat/completions, so "openai" (generic
    api_base-override provider) is the documented fit; onyx-deploy.md flags
    this as unverified against a live cliproxy — re-test via
    `POST /admin/llm/test` if provider creation in llm.tf fails validation,
    and try "anthropic" (cliproxy also serves /v1/messages) as a fallback.
  EOT
  default     = "openai"
}

# --- GitHub ------------------------------------------------------------------

variable "github_owner" {
  type        = string
  description = "GitHub org/user that owns the repos to index (issues + PRs)."
  default     = "frak-id"
}

variable "github_repos" {
  type        = list(string)
  description = "Repo names under github_owner to index. Empty = GitHub connector disabled."
  default     = []
}

variable "github_token" {
  type        = string
  sensitive   = true
  description = <<-EOT
    Fine-grained GitHub PAT, read-only, scoped to github_repos, with
    repository permissions "Contents: Read", "Issues: Read", "Pull requests:
    Read", "Metadata: Read". Empty = GitHub connector disabled.
  EOT
  default     = ""
}

# --- Slack (public channels only, rolling window) ----------------------------

variable "slack_bot_token" {
  type        = string
  sensitive   = true
  description = <<-EOT
    Slack bot token ("xoxb-...") from a Slack app installed with ONLY the
    public-channel scopes channels:history and channels:read (no groups:*) —
    see README "Slack app manifest". Empty = Slack connector disabled.
  EOT
  default     = ""
}

variable "slack_channels" {
  type        = list(string)
  description = "Public channel names to index. Empty list = all public channels the bot can see."
  default     = []
}

variable "slack_history_months" {
  type        = number
  description = "Rolling window of Slack history to keep indexed, in months. See README 'Monthly apply for the Slack window'."
  default     = 6
}

# --- Linear --------------------------------------------------------------

variable "linear_api_key" {
  type        = string
  sensitive   = true
  description = "Linear personal API key. Empty = Linear connector disabled."
  default     = ""
}

# --- Notion ----------------------------------------------------------------

variable "notion_token" {
  type        = string
  sensitive   = true
  description = "Notion internal integration token. Empty = Notion connector disabled."
  default     = ""
}

variable "notion_root_page_id" {
  type        = string
  description = "Restrict indexing to this page's subtree. Empty = index the whole workspace the integration can see."
  default     = ""
}

# --- Gmail (optional, off by default) ---------------------------------------

variable "gmail_enabled" {
  type        = bool
  description = "Enable the Gmail connector. Off by default per the company-knowledge decision."
  default     = false
}

variable "gmail_service_account_json" {
  type        = string
  sensitive   = true
  description = <<-EOT
    Google service-account JSON key with domain-wide delegation for Gmail
    read scope. The exact credential_json key name Onyx expects for this
    shape was unverified in research (see README "Known limitations") —
    confirm against `backend/onyx/connectors/gmail/connector.py`
    get_google_creds() for the deployed image version before relying on this.
  EOT
  default     = ""
}

variable "gmail_primary_admin_email" {
  type        = string
  description = "Mailbox the service account impersonates via domain-wide delegation."
  default     = ""
}

# --- Codebase wiki ingestion --------------------------------------------------

variable "wiki_sync_api_key_group_ids" {
  type        = list(number)
  description = <<-EOT
    Onyx user-group ids to scope the wiki-sync API key to. Onyx's group
    model (onyx_user_group) is Enterprise-only (404s on CE) — on CE this is
    left empty and the key inherits the bootstrap admin's uniform CE access
    (see README "Known limitations: no RBAC in CE"). Populate only if this
    deployment is upgraded to an EE license with real group ids.
  EOT
  default     = []
}

variable "agents_api_key_group_ids" {
  type        = list(number)
  description = "Same EE-only caveat as wiki_sync_api_key_group_ids, for the read-only 'agents' API key."
  default     = []
}

# --- Atelier MCP + agent -----------------------------------------------------

variable "atelier_mcp_url" {
  type        = string
  description = "Atelier's own MCP endpoint (streamable HTTP)."
  default     = "https://atelier.hetzner-staging.frak.id/mcp"
}

variable "atelier_admin_api_key" {
  type        = string
  sensitive   = true
  description = <<-EOT
    An Atelier API key ("atl_...") for the Onyx admin applying this
    Terraform, used as `admin_credentials.api_key` on the onyx_mcp_server
    resource (required by the provider for auth_performer = PER_USER — see
    its docs: "Onyx stores them against the identity that applied"). Every
    other Onyx user adds their own atl_ key from their own account
    afterwards — see README "The Atelier MCP action".
  EOT
}

variable "atelier_tool_ids" {
  type        = list(string)
  description = <<-EOT
    Escape hatch: Onyx Tool ids for the Atelier MCP server's launchpad_*
    tools, to attach to the Atelier agent's tool_ids INSTEAD of the ids
    atelier.tf discovers automatically via
    GET /admin/mcp/server/{id}/tools/snapshots?source=mcp (see atelier.tf's
    header comment and README "Known limitations: two-step MCP tool
    attachment"). Leave empty (the default) to use the discovered ids.
    Only needed if discovery is unreliable in your environment, or you want
    to pin a specific subset of the Atelier MCP server's tools.
  EOT
  default     = []
}

variable "atelier_search_tool_id" {
  type        = string
  description = <<-EOT
    Escape hatch: Onyx's built-in Search tool id, to use INSTEAD of the id
    atelier.tf discovers automatically from GET /tool by matching
    in_code_tool_id == "SearchTool" (see
    backend/onyx/tools/built_in_tools.py and
    backend/alembic/versions/d09fc20a3c66_seed_builtin_tools.py, which always
    seeds this tool at migration time — discovery failing here would mean
    the GET /tool call itself failed, not that the tool doesn't exist). Leave
    null (the default) to use the discovered id.
  EOT
  default     = null
}

variable "extra_tool_ids" {
  type        = list(string)
  description = <<-EOT
    Any additional Onyx Tool ids (other built-in tools like Web Search or
    Image Generation, or unrelated custom/OpenAPI actions) to attach to the
    Atelier agent's tool_ids, alongside the auto-discovered search + Atelier
    MCP tools.
  EOT
  default     = []
}
