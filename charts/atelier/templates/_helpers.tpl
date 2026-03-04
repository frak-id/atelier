{{- define "atelier.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "atelier.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "atelier.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "atelier.labels" -}}
app.kubernetes.io/name: {{ include "atelier.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "atelier.selectorLabels" -}}
app.kubernetes.io/name: {{ include "atelier.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "atelier.managerImage" -}}
{{- printf "%s:%s" .Values.manager.image.repository (default .Chart.AppVersion .Values.manager.image.tag) -}}
{{- end -}}

{{- define "atelier.dashboardImage" -}}
{{- printf "%s:%s" .Values.dashboard.image.repository (default .Chart.AppVersion .Values.dashboard.image.tag) -}}
{{- end -}}

{{- define "atelier.systemNamespace" -}}
{{- .Release.Namespace -}}
{{- end -}}

{{- define "atelier.sandboxNamespace" -}}
{{- .Values.kubernetes.namespace -}}
{{- end -}}

{{- define "atelier.dashboardDomain" -}}
{{- if .Values.domain.dashboard -}}
{{- .Values.domain.dashboard -}}
{{- else -}}
{{- printf "sandbox.%s" .Values.domain.baseDomain -}}
{{- end -}}
{{- end -}}

{{- define "atelier.wildcardTlsSecretName" -}}
{{- printf "%s-wildcard-tls" (include "atelier.fullname" .) -}}
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
