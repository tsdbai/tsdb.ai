{{- define "tsdb-ui.fullname" -}}
tsdb-ui
{{- end -}}

{{- define "tsdb-ui.namespace" -}}
{{- $global := (.Values.global | default dict) -}}
{{- $ns := default "tsdb-ai" (dig "namespace" "name" "tsdb-ai" ($global | default dict)) -}}
{{- default $ns .Release.Namespace -}}
{{- end -}}

{{- define "tsdb-ui.image" -}}
{{- $global := (.Values.global | default dict) -}}
{{- $registry := default (dig "image" "registry" "" $global) .Values.image.registry -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if $registry -}}
{{ $registry }}/{{ .Values.image.repository }}:{{ $tag }}
{{- else -}}
{{ .Values.image.repository }}:{{ $tag }}
{{- end -}}
{{- end -}}

{{- define "tsdb-ui.imagePullPolicy" -}}
{{- $global := (.Values.global | default dict) -}}
{{- default (dig "image" "pullPolicy" "IfNotPresent" $global) .Values.image.pullPolicy -}}
{{- end -}}

{{- define "tsdb-ui.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: ui
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: tsdb-ai
app: {{ include "tsdb-ui.fullname" . }}
{{- with (.Values.global | default dict).commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "tsdb-ui.selectorLabels" -}}
app: {{ include "tsdb-ui.fullname" . }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "tsdb-ui.imagePullSecrets" -}}
{{- $global := (.Values.global | default dict) -}}
{{- with (dig "imagePullSecrets" (list) $global) }}
imagePullSecrets:
{{- range . }}
  - name: {{ .name | default . }}
{{- end }}
{{- end }}
{{- end -}}
