output "llm_provider_id" {
  value = onyx_llm_provider.cliproxy.id
}

output "wiki_cc_pair_id" {
  description = "cc_pair_id to pass as /onyx-api/ingestion's document.cc_pair_id."
  value       = onyx_cc_pair.wiki_ingestion.id
}

output "wiki_document_set_id" {
  value = onyx_document_set.codebase_wiki.id
}

output "wiki_sync_api_key" {
  description = "Bearer token for the wiki-sync job's calls to /onyx-api/ingestion. Only ever returned once, by Terraform, at creation."
  value       = onyx_api_key.wiki_sync.api_key
  sensitive   = true
}

output "agents_api_key" {
  description = "Bearer token for Onyx-MCP clients (opencode/Claude Code/pi) in Atelier sandboxes and Open-Inspect."
  value       = onyx_api_key.agents.api_key
  sensitive   = true
}

output "atelier_mcp_server_id" {
  value = onyx_mcp_server.atelier.id
}

output "atelier_agent_id" {
  value = onyx_agent.atelier.id
}

output "github_cc_pair_id" {
  value = length(onyx_cc_pair.github) > 0 ? onyx_cc_pair.github[0].id : null
}

output "slack_cc_pair_id" {
  value = length(onyx_cc_pair.slack) > 0 ? onyx_cc_pair.slack[0].id : null
}

output "linear_cc_pair_id" {
  value = length(onyx_cc_pair.linear) > 0 ? onyx_cc_pair.linear[0].id : null
}

output "notion_cc_pair_id" {
  value = length(onyx_cc_pair.notion) > 0 ? onyx_cc_pair.notion[0].id : null
}

output "gmail_cc_pair_id" {
  value = length(onyx_cc_pair.gmail) > 0 ? onyx_cc_pair.gmail[0].id : null
}
