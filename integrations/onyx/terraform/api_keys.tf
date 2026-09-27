# Two Terraform-managed API keys. See variables.tf wiki_sync_api_key_group_ids
# / agents_api_key_group_ids and README "Known limitations: no RBAC in CE" —
# Onyx's group model (onyx_user_group, and thus group-scoping an API key) is
# Enterprise-only and 404s on Community Edition, so both keys below inherit
# the bootstrap admin's uniform CE-wide access rather than being genuinely
# restricted. group_ids is left as an empty-by-default variable so this
# tightens automatically if the deployment is ever upgraded to an EE license.

# Used by the wiki-sync job (generated elsewhere) to call
# POST /onyx-api/ingestion against onyx_cc_pair.wiki_ingestion.
resource "onyx_api_key" "wiki_sync" {
  name      = "wiki-sync-job"
  group_ids = var.wiki_sync_api_key_group_ids
}

# For coding agents (opencode / Claude Code / pi) hitting Onyx's own MCP
# server (search_indexed_documents, open_urls) from Atelier sandboxes /
# Open-Inspect sessions. See README "Onyx MCP for sandboxes".
resource "onyx_api_key" "agents" {
  name      = "agents-mcp"
  group_ids = var.agents_api_key_group_ids
}
