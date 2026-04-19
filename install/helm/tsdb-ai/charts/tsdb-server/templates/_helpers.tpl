{{/*
Fully-qualified component name. Fixed to "tsdb-server" so the Service matches
what the Ingress and other components expect.
*/}}
{{- define "tsdb-server.fullname" -}}
tsdb-server
{{- end -}}

{{/*
Namespace resolution: respect --namespace, fall back to the umbrella's
namespace.name if available, then "tsdb-ai".
*/}}
{{- define "tsdb-server.namespace" -}}
{{- $global := (.Values.global | default dict) -}}
{{- $ns := default "tsdb-ai" (dig "namespace" "name" "tsdb-ai" ($global | default dict)) -}}
{{- default $ns .Release.Namespace -}}
{{- end -}}

{{/*
Image reference. Registry / pullPolicy inherit from `global` when unset on the
subchart. Tag defaults to the chart's AppVersion.
*/}}
{{- define "tsdb-server.image" -}}
{{- $global := (.Values.global | default dict) -}}
{{- $registry := default (dig "image" "registry" "" $global) .Values.image.registry -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if $registry -}}
{{ $registry }}/{{ .Values.image.repository }}:{{ $tag }}
{{- else -}}
{{ .Values.image.repository }}:{{ $tag }}
{{- end -}}
{{- end -}}

{{- define "tsdb-server.imagePullPolicy" -}}
{{- $global := (.Values.global | default dict) -}}
{{- default (dig "image" "pullPolicy" "IfNotPresent" $global) .Values.image.pullPolicy -}}
{{- end -}}

{{/*
Labels shared by every resource this subchart owns.
*/}}
{{- define "tsdb-server.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: server
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: tsdb-ai
app: {{ include "tsdb-server.fullname" . }}
{{- with (.Values.global | default dict).commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "tsdb-server.selectorLabels" -}}
app: {{ include "tsdb-server.fullname" . }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Merged image pull secrets (global only — no per-subchart override today).
*/}}
{{- define "tsdb-server.imagePullSecrets" -}}
{{- $global := (.Values.global | default dict) -}}
{{- with (dig "imagePullSecrets" (list) $global) }}
imagePullSecrets:
{{- range . }}
  - name: {{ .name | default . }}
{{- end }}
{{- end }}
{{- end -}}
