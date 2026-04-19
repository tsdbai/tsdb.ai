{{- define "tsdb-scraper.fullname" -}}
tsdb-scraper
{{- end -}}

{{- define "tsdb-scraper.namespace" -}}
{{- $global := (.Values.global | default dict) -}}
{{- $ns := default "tsdb-ai" (dig "namespace" "name" "tsdb-ai" ($global | default dict)) -}}
{{- default $ns .Release.Namespace -}}
{{- end -}}

{{- define "tsdb-scraper.image" -}}
{{- $global := (.Values.global | default dict) -}}
{{- $registry := default (dig "image" "registry" "" $global) .Values.image.registry -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if $registry -}}
{{ $registry }}/{{ .Values.image.repository }}:{{ $tag }}
{{- else -}}
{{ .Values.image.repository }}:{{ $tag }}
{{- end -}}
{{- end -}}

{{- define "tsdb-scraper.imagePullPolicy" -}}
{{- $global := (.Values.global | default dict) -}}
{{- default (dig "image" "pullPolicy" "IfNotPresent" $global) .Values.image.pullPolicy -}}
{{- end -}}

{{- define "tsdb-scraper.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: scraper
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: tsdb-ai
app: {{ include "tsdb-scraper.fullname" . }}
{{- with (.Values.global | default dict).commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "tsdb-scraper.selectorLabels" -}}
app: {{ include "tsdb-scraper.fullname" . }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "tsdb-scraper.imagePullSecrets" -}}
{{- $global := (.Values.global | default dict) -}}
{{- with (dig "imagePullSecrets" (list) $global) }}
imagePullSecrets:
{{- range . }}
  - name: {{ .name | default . }}
{{- end }}
{{- end }}
{{- end -}}
