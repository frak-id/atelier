{{/*
Chart name, truncated to 63 chars.
*/}}
{{- define "atelier.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name. Avoids "atelier-atelier" duplication when
the release name already contains the chart name.
*/}}
{{- define "atelier.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Standard labels applied to every resource.
*/}}
{{- define "atelier.labels" -}}
app.kubernetes.io/name: {{ include "atelier.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{/*
Selector labels used in Deployment matchLabels / Service selectors.
*/}}
{{- define "atelier.selectorLabels" -}}
app.kubernetes.io/name: {{ include "atelier.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Manager container image.
*/}}
{{- define "atelier.managerImage" -}}
{{- printf "%s:%s" .Values.manager.image.repository (default .Chart.AppVersion .Values.manager.image.tag) -}}
{{- end -}}

{{/*
Dashboard (nginx sidecar) container image.
*/}}
{{- define "atelier.dashboardImage" -}}
{{- printf "%s:%s" .Values.dashboard.image.repository (default .Chart.AppVersion .Values.dashboard.image.tag) -}}
{{- end -}}

{{/*
System namespace (where the chart is installed).
*/}}
{{- define "atelier.systemNamespace" -}}
{{- .Release.Namespace -}}
{{- end -}}

{{/*
Sandbox namespace (where sandbox pods run).
*/}}
{{- define "atelier.sandboxNamespace" -}}
{{- .Values.kubernetes.namespace -}}
{{- end -}}

{{/*
Dashboard domain, defaulting to sandbox.{baseDomain}.
*/}}
{{- define "atelier.dashboardDomain" -}}
{{- if .Values.domain.dashboard -}}
{{- .Values.domain.dashboard -}}
{{- else -}}
{{- printf "sandbox.%s" .Values.domain.baseDomain -}}
{{- end -}}
{{- end -}}

{{/*
Wildcard TLS secret name (system namespace).
*/}}
{{- define "atelier.wildcardTlsSecretName" -}}
{{- printf "%s-wildcard-tls" (include "atelier.fullname" .) -}}
{{- end -}}

{{/*
Wildcard TLS secret name (sandbox namespace).
*/}}
{{- define "atelier.sandboxWildcardTlsSecretName" -}}
{{- printf "%s-sandbox-wildcard-tls" (include "atelier.fullname" .) -}}
{{- end -}}

{{/*
ServiceAccount name.
*/}}
{{- define "atelier.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (printf "%s-manager" (include "atelier.fullname" .)) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Manager secret name — uses existingSecret if set, otherwise generates one.
*/}}
{{- define "atelier.managerSecretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-manager-secret" (include "atelier.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
imagePullSecrets block.
*/}}
{{- define "atelier.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
Ingress annotations for VS Code sandbox ingresses.
When ingress.className is "traefik", emits the Traefik forwardAuth middleware annotation.
Otherwise emits an empty dict so the manager receives no extra annotations.
*/}}
{{- define "atelier.vsCodeIngressAnnotations" -}}
{{- if eq .Values.ingress.className "traefik" -}}
{{- $ns := include "atelier.sandboxNamespace" . -}}
{{- $name := printf "%s-auth-verify" (include "atelier.fullname" .) -}}
{{- dict "traefik.ingress.kubernetes.io/router.middlewares" (printf "%s-%s@kubernetescrd" $ns $name) | toJson -}}
{{- else -}}
{}
{{- end -}}
{{- end -}}

{{/*
Ingress annotations for OpenCode sandbox ingresses.
When ingress.className is "traefik", emits the Traefik forwardAuth middleware annotation.
Otherwise emits an empty dict so the manager receives no extra annotations.
*/}}
{{- define "atelier.openCodeIngressAnnotations" -}}
{{- if eq .Values.ingress.className "traefik" -}}
{{- $ns := include "atelier.sandboxNamespace" . -}}
{{- $name := printf "%s-auth-opencode" (include "atelier.fullname" .) -}}
{{- dict "traefik.ingress.kubernetes.io/router.middlewares" (printf "%s-%s@kubernetescrd" $ns $name) | toJson -}}
{{- else -}}
{}
{{- end -}}
{{- end -}}

{{/*
CLIProxy domain, defaulting to cliproxy.{baseDomain}.
*/}}
{{- define "atelier.cliproxyDomain" -}}
{{- printf "cliproxy.%s" .Values.domain.baseDomain -}}
{{- end -}}

{{/*
CLIProxy container image.
*/}}
{{- define "atelier.cliproxyImage" -}}
{{- printf "%s:%s" .Values.cliproxy.image.repository .Values.cliproxy.image.tag -}}
{{- end -}}
