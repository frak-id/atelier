# Slack: public channels only (enforced by the Slack app's OAuth scopes —
# channels:history / channels:read, no groups:*, see README "Slack app
# manifest" — Onyx has no separate "public channels only" config knob), kept
# to a rolling last-N-months window.
#
# Why a rotating replace instead of a single indexing_start:
#
# Onyx's `indexing_start` on a connector is a single fixed timestamp, not a
# rolling window (confirmed both by reading
# backend/onyx/connectors/slack/connector.py and ConnectorBase in
# backend/onyx/server/documents/models.py
# https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/server/documents/models.py
# and by the terraform provider's own connector resource docs
# https://registry.terraform.io/providers/onyx-dot-app/onyx/latest/docs/resources/connector:
# "Onyx ignores it on update, so changing it replaces the connector"). Pruning
# (backend/onyx/background/celery/celery_utils.py's
# retrieve_all_slim_docs_perm_sync()) re-lists ALL current Slack history with
# no `start` bound, so it cannot enforce a retention window either — it only
# removes documents Slack itself no longer reports (e.g. deleted messages),
# not documents older than N months that Slack still has.
#
# So the only correct mechanism is: recompute indexing_start = now - N months
# on a schedule, which — because indexing_start is force-replace — recreates
# the connector (a fresh onyx_connector row) and, transitively, the cc_pair
# (whose connector_id changed). Per the provider's cc_pair.md: "Destroying a
# pair also removes the documents it indexed, which Onyx does in the
# background" — so each monthly replace deletes the old cc_pair's indexed
# Slack docs and the new cc_pair backfills exactly the last N months again.
#
# time_rotating's rfc3339 value only advances once the rotation period has
# actually elapsed *and* a plan/apply is run against it — so `terraform
# apply` must run on a schedule (monthly CI cron; see README "Monthly apply
# for the Slack window") for the rotation, and therefore the deletion +
# backfill, to actually happen.
resource "time_rotating" "slack_window" {
  rotation_months = 1
}

resource "onyx_credential" "slack" {
  count  = var.slack_bot_token != "" ? 1 : 0
  source = "slack"
  name   = "slack-public-channels"

  credential_json_wo         = jsonencode({ slack_bot_token = var.slack_bot_token })
  credential_json_wo_version = 1
}

resource "onyx_connector" "slack" {
  count      = var.slack_bot_token != "" ? 1 : 0
  name       = "slack-public-channels"
  source     = "slack"
  input_type = "poll"

  refresh_freq = 3600  # 1h
  prune_freq   = 86400 # 1d — cleans up messages Slack itself has deleted

  # Recomputed (and force-replaces this connector) whenever
  # time_rotating.slack_window rotates — see the file header above.
  indexing_start = timeadd(time_rotating.slack_window.rfc3339, "-${var.slack_history_months * 730}h")

  connector_specific_config = jsonencode({
    channels              = var.slack_channels
    channel_regex_enabled = false
    exclude_channels      = []
  })
}

resource "onyx_cc_pair" "slack" {
  count         = var.slack_bot_token != "" ? 1 : 0
  name          = "slack-public-channels"
  connector_id  = onyx_connector.slack[0].id # replaced monthly -> forces this cc_pair to replace too
  credential_id = onyx_credential.slack[0].id
  access_type   = "public"
}
