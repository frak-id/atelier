# Atelier's own MCP endpoint, registered PER_USER so each Onyx user acts as
# themselves in Atelier (their own atl_ key -> their own Launchpad
# workspaces stay theirs, per the company-knowledge decision).
#
# admin_credentials is the applying admin's own atl_ key, required by the
# provider for auth_performer = PER_USER (it's how Onyx first calls the
# server to discover its tools — see onyx_mcp_server's docs: "Onyx stores
# them against the identity that applied"). Every other Onyx user adds their
# own atl_ key from Settings -> Actions -> Atelier in the Onyx UI afterwards;
# see README "The Atelier MCP action".
resource "onyx_mcp_server" "atelier" {
  name        = "Atelier"
  description = "Launch and inspect Atelier Launchpad workspaces"
  server_url  = var.atelier_mcp_url

  auth_type      = "API_TOKEN"
  auth_performer = "PER_USER"

  auth_template_headers = {
    "Authorization" = "Bearer {api_key}"
  }

  admin_credentials_wo = {
    api_key = var.atelier_admin_api_key
  }
  admin_credentials_wo_version = 1

  is_public = true
}

# --- Tool discovery for the Atelier agent -----------------------------------
#
# Onyx's own search is a built-in *tool*, not something implicit: a persona
# with no search-capable tool_ids has no search at all (see the
# `PersonaUpsertRequest.tool_ids` comment "e.g. ID of SearchTool" in
# backend/onyx/server/features/persona/models.py:
# https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/server/features/persona/models.py).
# The onyx Terraform provider has no data source for either the built-in
# Search tool's id or the Atelier MCP server's discovered tool ids, so both
# are read here directly from Onyx's own REST API via the hashicorp/http
# provider.
#
# `onyx_url` is the external origin (e.g. https://onyx.hetzner-staging.frak.id)
# but the chart's own ingress-api.yaml rewrites `/api(/|$)(.*)` -> `/$2`
# before it reaches the backend (see helm/values.yaml's own
# onyx-api-stripprefix Middleware, doing the Traefik-equivalent of that same
# rewrite) — so every call below is prefixed with /api to match, exactly
# like the onyx provider's own client does by default (api_prefix defaults
# to "/api": terraform-provider-onyx's internal/provider/provider.go).
#
# 1. Built-in Search tool id: GET /api/tool lists every enabled tool visible
#    to the caller (backend/onyx/server/features/tool/api.py `list_tools`,
#    router prefix "/tool"). Built-in tools are seeded once, at migration
#    time, with a stable `in_code_tool_id` equal to the tool class's own
#    name (backend/alembic/versions/d09fc20a3c66_seed_builtin_tools.py seeds
#    `{"name": "SearchTool", "in_code_tool_id": "SearchTool", ...}`,
#    matching BUILT_IN_TOOL_MAP's `SearchTool.__name__` key in
#    backend/onyx/tools/built_in_tools.py) — so it is always present and
#    never needs discovery, just a lookup by that id.
#
#    Onyx does hide two built-in tools from this listing on purpose
#    (`TOOL_VISIBILITY_CONFIG[...].expose_to_frontend = False` in
#    backend/onyx/server/features/tool/tool_visibility.py:
#    https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/server/features/tool/tool_visibility.py)
#    — OktaProfileTool and MemoryTool. SearchTool is not one of the two
#    (its entry is absent from that config map, which defaults to exposed),
#    so GET /tool always lists it when the built-in tools have been seeded.
#
# 2. Atelier MCP tool ids: the provider's own `onyx_mcp_server` resource only
#    ever calls POST /admin/mcp/servers/create
#    (terraform-provider-onyx's internal/client/mcp_server.go
#    `UpsertMCPServer`), which creates the server row and its auth config but
#    never calls out to the MCP server itself — tool discovery is a
#    genuinely separate action
#    (backend/onyx/server/features/mcp/api.py: `POST /admin/mcp/servers/update`
#    or `GET /admin/mcp/server/{id}/tools/snapshots?source=mcp`, both of which
#    call `discover_mcp_tools(...)` and sync the results into the `tool`
#    table). Nothing in onyx_mcp_server's create/read/update lifecycle
#    triggers that, so without an explicit call here, Atelier's launchpad_*
#    tools would never appear no matter how many times `terraform apply`
#    reruns. `data.http.atelier_mcp_tools` below is that explicit call: its
#    `source=mcp` query param makes Onyx re-connect to Atelier's own /mcp
#    endpoint (using the admin_credentials_wo given to onyx_mcp_server.atelier)
#    and sync whatever it finds, then returns exactly those tools — already
#    scoped to this server, no client-side `mcp_server_id` filtering needed.
#
# First-apply caveat: this discovery call runs as part of the same apply as
# onyx_mcp_server.atelier (via depends_on below), so it normally succeeds on
# the very first apply. It can still legitimately come back empty (a non-2xx
# status, or a 200 with zero tools) if Atelier's /mcp endpoint isn't yet
# reachable from the Onyx pod (DNS/ingress propagation) or the MCP server's
# auth hasn't settled yet — the http provider does not error on non-2xx
# statuses (hashicorp/terraform-provider-http's data_source_http.go only
# errors on network/parse failures), so `terraform apply` still succeeds,
# but the agent is left with no Atelier tools that run. In that case,
# `terraform apply` again — it will retry discovery. `var.atelier_tool_ids`
# is the escape hatch if discovery keeps failing (see variables.tf).
data "http" "onyx_tools" {
  url = "${var.onyx_url}/api/tool"

  request_headers = {
    Authorization = "Bearer ${var.onyx_api_key}"
  }
}

data "http" "atelier_mcp_tools" {
  url = "${var.onyx_url}/api/admin/mcp/server/${onyx_mcp_server.atelier.id}/tools/snapshots?source=mcp"

  request_headers = {
    Authorization = "Bearer ${var.onyx_api_key}"
  }

  # Must run after the server exists, and its own auth is what discovery
  # authenticates with server-side — see the header comment above.
  depends_on = [onyx_mcp_server.atelier]
}

locals {
  # try(...) so a non-2xx / unparseable body degrades to "nothing found" on
  # this apply (see the first-apply caveat above) rather than failing the
  # whole plan — the precondition on onyx_agent.atelier below is what turns
  # a missing Search tool into a loud, actionable error instead of a silent
  # no-search agent.
  onyx_tools_by_id = try(jsondecode(data.http.onyx_tools.response_body), [])

  discovered_search_tool_ids = [
    for t in local.onyx_tools_by_id : tostring(t.id)
    if try(t.in_code_tool_id, null) == "SearchTool"
  ]

  atelier_discovered_tool_ids = try(
    [for t in jsondecode(data.http.atelier_mcp_tools.response_body) : tostring(t.id)],
    []
  )

  search_tool_ids = (
    var.atelier_search_tool_id != null
    ? [var.atelier_search_tool_id]
    : local.discovered_search_tool_ids
  )

  atelier_tool_ids = (
    length(var.atelier_tool_ids) > 0
    ? var.atelier_tool_ids
    : local.atelier_discovered_tool_ids
  )

  atelier_agent_tool_ids = distinct(concat(
    local.search_tool_ids,
    local.atelier_tool_ids,
    var.extra_tool_ids,
  ))
}

# One featured, public "Atelier" agent: company-knowledge assistant that
# cites sources, searches first, and can launch/inspect Launchpad workspaces
# via the Atelier MCP tools when a user wants work done.
#
# tool_ids = local.atelier_agent_tool_ids: the built-in Search tool (without
# it the agent has no search capability at all, per
# PersonaUpsertRequest.tool_ids above) plus every tool Onyx discovered on
# onyx_mcp_server.atelier plus var.extra_tool_ids — see the data-source block
# above for how each piece is resolved and README "Known limitations:
# two-step MCP tool attachment" for the operational caveat. No
# document_set_ids: the agent searches everything (company knowledge is
# public/company-wide per the decision), not scoped to any one document set.
resource "onyx_agent" "atelier" {
  name        = "Atelier"
  description = "Company knowledge assistant with Launchpad tools"

  system_prompt = <<-EOT
    You are Atelier, the company knowledge assistant. Search company
    knowledge (GitHub issues/PRs, the codebase wiki, Slack, Linear, Notion)
    before answering, and always cite your sources (link back to the
    original document/message/page).

    If the user wants work done — implementing something, investigating a
    bug, running a task — use the launchpad_catalog, launchpad_launch,
    launchpad_workspaces and launchpad_workspace tools to launch or inspect
    an Atelier Launchpad workspace for them, rather than only describing what
    to do.
  EOT

  tool_ids = local.atelier_agent_tool_ids

  is_public   = true
  is_featured = true

  lifecycle {
    precondition {
      condition     = length(local.search_tool_ids) > 0
      error_message = <<-EOT
        Could not resolve Onyx's built-in Search tool id from
        GET ${var.onyx_url}/api/tool (matching in_code_tool_id ==
        "SearchTool" — see backend/onyx/tools/built_in_tools.py). Without
        it, the Atelier agent would have no search tool at all. Either
        retry `terraform apply` (the GET /tool call may have failed
        transiently), or set var.atelier_search_tool_id by hand (Admin ->
        Actions in the Onyx UI, or GET /api/tool) as the escape hatch.
      EOT
    }
  }
}
