terraform {
  # >= 1.11 for write-only arguments (_wo / _wo_version), used throughout to
  # keep secrets out of state where the provider offers the pair.
  required_version = ">= 1.11"

  required_providers {
    onyx = {
      source  = "onyx-dot-app/onyx"
      version = "~> 0.3"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
    # Used by atelier.tf to read Onyx's own /tool and
    # /admin/mcp/server/{id}/tools/snapshots REST endpoints directly — the
    # onyx provider has no data source for either (see atelier.tf's header
    # comment for why this is necessary).
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}
