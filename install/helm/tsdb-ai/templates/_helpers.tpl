{{/*
Common helpers for the tsdb-ai umbrella chart.
Subcharts define their own _helpers.tpl for component-level names.
*/}}

{{/*
The namespace to deploy into. Honors --namespace / -n, and falls back to
.Values.namespace.name (default "tsdb-ai") so that rendered manifests carry
an explicit namespace.
*/}}
{{- define "tsdb-ai.namespace" -}}
{{- default .Values.namespace.name .Release.Namespace -}}
{{- end -}}

{{/*
Labels shared by every resource the umbrella owns directly.
*/}}
{{- define "tsdb-ai.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: tsdb-ai
{{- with .Values.global.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}
