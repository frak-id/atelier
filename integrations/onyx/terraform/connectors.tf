# GitHub, Linear, Notion — each gated on its secret being provided (empty
# secret = connector disabled entirely). Slack has its own file (slack.tf)
# because of the rolling-window rotation mechanism. Gmail is gated on
# var.gmail_enabled (off by default).
#
# Per-source connector_specific_config / credential_json shapes are read
# directly from backend/onyx/connectors/*/connector.py __init__/
# load_credentials — see, per source, github/connector.py, slack/connector.py,
# linear/connector.py, notion/connector.py, gmail/connector.py under
# https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/connectors/ —
# and docs/research/company-knowledge-tools.md for the full research trail.

# --- GitHub (issues + PRs; include_files=false, code goes through the
# codebase wiki via wiki.tf instead) -----------------------------------------

resource "onyx_credential" "github" {
  count  = length(var.github_repos) > 0 ? 1 : 0
  source = "github"
  name   = "github-${var.github_owner}"

  credential_json_wo         = jsonencode({ github_access_token = var.github_token })
  credential_json_wo_version = 1
}

resource "onyx_connector" "github" {
  count      = length(var.github_repos) > 0 ? 1 : 0
  name       = "github-${var.github_owner}"
  source     = "github"
  input_type = "poll"

  refresh_freq = 3600  # 1h
  prune_freq   = 86400 # 1d

  connector_specific_config = jsonencode({
    repo_owner     = var.github_owner
    repositories   = join(",", var.github_repos)
    state_filter   = "all"
    include_prs    = true
    include_issues = true
    include_files  = false # code goes through the codebase wiki, see wiki.tf
  })
}

resource "onyx_cc_pair" "github" {
  count         = length(var.github_repos) > 0 ? 1 : 0
  name          = "github-${var.github_owner}"
  connector_id  = onyx_connector.github[0].id
  credential_id = onyx_credential.github[0].id
  access_type   = "public"
}

# --- Linear ------------------------------------------------------------------

resource "onyx_credential" "linear" {
  count  = var.linear_api_key != "" ? 1 : 0
  source = "linear"
  name   = "linear-atelier"

  credential_json_wo         = jsonencode({ linear_api_key = var.linear_api_key })
  credential_json_wo_version = 1
}

resource "onyx_connector" "linear" {
  count      = var.linear_api_key != "" ? 1 : 0
  name       = "linear-atelier"
  source     = "linear"
  input_type = "poll"

  refresh_freq = 3600
  prune_freq   = 86400

  connector_specific_config = jsonencode({ batch_size = 10 })
}

resource "onyx_cc_pair" "linear" {
  count         = var.linear_api_key != "" ? 1 : 0
  name          = "linear-atelier"
  connector_id  = onyx_connector.linear[0].id
  credential_id = onyx_credential.linear[0].id
  access_type   = "public"
}

# --- Notion ------------------------------------------------------------------

resource "onyx_credential" "notion" {
  count  = var.notion_token != "" ? 1 : 0
  source = "notion"
  name   = "notion-atelier"

  credential_json_wo         = jsonencode({ notion_integration_token = var.notion_token })
  credential_json_wo_version = 1
}

resource "onyx_connector" "notion" {
  count      = var.notion_token != "" ? 1 : 0
  name       = "notion-atelier"
  source     = "notion"
  input_type = "poll"

  refresh_freq = 3600
  prune_freq   = 86400

  connector_specific_config = jsonencode({
    batch_size              = 10
    recursive_index_enabled = true
    root_page_id            = var.notion_root_page_id != "" ? var.notion_root_page_id : null
  })
}

resource "onyx_cc_pair" "notion" {
  count         = var.notion_token != "" ? 1 : 0
  name          = "notion-atelier"
  connector_id  = onyx_connector.notion[0].id
  credential_id = onyx_credential.notion[0].id
  access_type   = "public"
}

# --- Gmail (optional, off by default) ----------------------------------------
#
# credential_json key names here are a best-effort shape (unverified — the
# exact literal key for DB_CREDENTIALS_PRIMARY_ADMIN_KEY and the
# service-account JSON blob's field name were not confirmed against source).
# Confirm against backend/onyx/connectors/gmail/connector.py's
# get_google_creds():
# https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/connectors/gmail/connector.py
# for the deployed image tag before relying on this in production. See also
# docs/research/company-knowledge-tools.md.

resource "onyx_credential" "gmail" {
  count  = var.gmail_enabled ? 1 : 0
  source = "gmail"
  name   = "gmail-atelier"

  credential_json_wo = jsonencode({
    google_service_account_key = var.gmail_service_account_json
    google_primary_admin       = var.gmail_primary_admin_email
  })
  credential_json_wo_version = 1
}

resource "onyx_connector" "gmail" {
  count      = var.gmail_enabled ? 1 : 0
  name       = "gmail-atelier"
  source     = "gmail"
  input_type = "poll"

  refresh_freq = 3600
  prune_freq   = 86400

  connector_specific_config = jsonencode({ batch_size = 10 })
}

resource "onyx_cc_pair" "gmail" {
  count         = var.gmail_enabled ? 1 : 0
  name          = "gmail-atelier"
  connector_id  = onyx_connector.gmail[0].id
  credential_id = onyx_credential.gmail[0].id
  access_type   = "public"
}
