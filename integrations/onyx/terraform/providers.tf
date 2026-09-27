# The onyx provider's own auth is a chicken-and-egg: the API key it
# authenticates with must be created out-of-band (Onyx admin UI, after the
# first-user-becomes-admin signup) before the first `terraform apply` — see
# README "Setup" step 2. `endpoint`/`api_key` can also come from the
# ONYX_SERVER_URL / ONYX_API_KEY env vars instead of these variables.
provider "onyx" {
  endpoint = var.onyx_url
  api_key  = var.onyx_api_key
}
