# cliproxy as Onyx's only LLM provider. api_key_wo keeps the cliproxy bearer
# token out of state (needs Terraform >= 1.11, pinned in versions.tf).
resource "onyx_llm_provider" "cliproxy" {
  name          = "atelier-cliproxy"
  provider_type = var.llm_provider
  api_base      = var.llm_base_url

  api_key_wo         = var.llm_api_key
  api_key_wo_version = 1

  is_public = true

  model_configurations = [
    { name = var.llm_model },
  ]
}

resource "onyx_llm_provider_default" "this" {
  provider_id = onyx_llm_provider.cliproxy.id
  model_name  = var.llm_model
}
