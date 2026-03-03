# GitHub Actions Workflows

These workflow files need to be placed in `.github/workflows/`.
The push was blocked because the OAuth token lacks the `workflow` scope.

## `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: "latest"

      - name: Install dependencies
        run: bun install

      - name: Lint and format
        run: bun run check

      - name: Typecheck
        run: bun run typecheck

  helm-lint:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Helm
        uses: azure/setup-helm@v4
        with:
          version: "v3.17.3"

      - name: Lint chart
        run: helm lint charts/atelier
```

## `.github/workflows/release.yml` (replaces existing)

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write
  packages: write

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ghcr.io/frak-id/atelier-manager

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: "latest"

      - name: Install dependencies
        run: bun install

      - name: Lint and format
        run: bun run check

      - name: Typecheck
        run: bun run typecheck

  docker:
    needs: check
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Extract version from tag
        id: version
        run: echo "version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.IMAGE_NAME }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,prefix=

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  helm:
    needs: check
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Extract version from tag
        id: version
        run: echo "version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"

      - name: Setup Helm
        uses: azure/setup-helm@v4
        with:
          version: "v3.17.3"

      - name: Log in to GHCR (Helm OCI)
        run: echo "${{ secrets.GITHUB_TOKEN }}" | helm registry login ${{ env.REGISTRY }} -u ${{ github.actor }} --password-stdin

      - name: Package chart
        run: |
          helm package charts/atelier \
            --version "${{ steps.version.outputs.version }}" \
            --app-version "${{ steps.version.outputs.version }}"

      - name: Push chart to GHCR
        run: helm push atelier-${{ steps.version.outputs.version }}.tgz oci://${{ env.REGISTRY }}/frak-id/charts

  release:
    needs: [docker, helm]
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Extract version from tag
        id: version
        run: echo "version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          body: |
            ## Installation

            ```bash
            helm install atelier oci://ghcr.io/frak-id/charts/atelier \
              --version ${{ steps.version.outputs.version }} \
              --namespace atelier-system --create-namespace \
              --values values.production.yaml
            ```

            ## Docker Image

            ```bash
            docker pull ghcr.io/frak-id/atelier-manager:${{ steps.version.outputs.version }}
            ```
```
