# Ingestion target for the generated codebase-wiki pages. The Onyx Terraform
# provider has no dedicated "ingestion target" resource — /onyx-api/ingestion
# just needs *a* cc_pair id to attach documents to. The simplest bootstrap
# pattern (per docs.onyx.app's ingestion guide
# https://docs.onyx.app/developers/guides/index_files_ingestion_api and
# backend/onyx/server/onyx_api/ingestion.py
# https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/server/onyx_api/ingestion.py)
# is: create one dummy Connector with source: ingestion_api and a dummy
# Credential, link them once to get a cc_pair_id. `source = "ingestion_api"`
# is a real DocumentSource enum value
# (backend/onyx/configs/constants.py:
# https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/configs/constants.py)
# that Onyx special-cases in connectors/factory.py
# (https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/connectors/factory.py)
# to skip normal credential validation, so an empty credential and an empty
# connector_specific_config are both valid here — this connector/cc_pair
# never actually runs an index attempt, it only exists to be the ingestion
# API's `cc_pair_id` target. See also docs/research/company-knowledge-tools.md
# and README "Codebase wiki" for how integrations/codewiki/ uses this
# cc_pair_id.
resource "onyx_credential" "wiki_ingestion" {
  source = "ingestion_api"
  name   = "codebase-wiki-ingestion"

  # No real secret needed for this source; the provider requires exactly one
  # of credential_json/credential_json_wo to be set regardless.
  credential_json = jsonencode({})
}

resource "onyx_connector" "wiki_ingestion" {
  name       = "codebase-wiki-ingestion"
  source     = "ingestion_api"
  input_type = "load_state" # push-only; Onyx never polls this connector itself

  connector_specific_config = jsonencode({})
}

resource "onyx_cc_pair" "wiki_ingestion" {
  name          = "codebase-wiki-ingestion"
  connector_id  = onyx_connector.wiki_ingestion.id
  credential_id = onyx_credential.wiki_ingestion.id
  access_type   = "public"
}

resource "onyx_document_set" "codebase_wiki" {
  name        = "codebase-wiki"
  description = "Generated codebase wiki pages only (pushed via /onyx-api/ingestion)"

  cc_pair_ids = [onyx_cc_pair.wiki_ingestion.id]
}
