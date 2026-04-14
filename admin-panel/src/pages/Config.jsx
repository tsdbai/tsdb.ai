import { useState, useEffect } from 'react'
import { useTheme } from '../context/ThemeContext'
import { fetchLiveConfig, saveConfig } from '../api'
import {
  Settings, Download, RefreshCw, ChevronDown, ChevronUp,
  Server, Database, Zap, Search, AlertTriangle, BookMarked,
  GitBranch, Activity, Cloud, Cpu, Radio, TrendingUp, Check,
  Upload, X, AlertCircle, Edit3,
} from 'lucide-react'

// ─── Full config schema (mirrors tsdb.yaml) ──────────────────────────────────

const SECTIONS = [
  {
    key: 'server', title: 'Network / Ports', icon: Server, color: T.cyan,
    desc: 'Ports each service listens on and internal endpoint wiring. Any port change must be mirrored in supervisord.conf and any k8s/firewall rules.',
    fields: [
      { key: 'ingest_port',      label: 'Ingest Port',      type: 'number', default: 8080, unit: 'port', desc: 'HTTP port for the Ingestor service. Prometheus scrapers and the self-exporter POST metrics here.' },
      { key: 'query_port',       label: 'Query Port',       type: 'number', default: 8081, unit: 'port', desc: 'HTTP port for the Query Gateway. Exposes a Prometheus-compatible /api/v1 interface.' },
      { key: 'deduper_port',     label: 'Deduper Port',     type: 'number', default: 8084, unit: 'port', desc: 'HTTP port for the Deduplication Service. Receives staged blocks from the WAL Shipper.' },
      { key: 'exporter_port',    label: 'Exporter Port',    type: 'number', default: 9102, unit: 'port', desc: 'Prometheus metrics endpoint for TSDB.ai self-monitoring. The Scraper Agent polls this port.' },
      { key: 'vector_port',      label: 'Vector Port',      type: 'number', default: 8085, unit: 'port', desc: 'HTTP port for the Vector Store service. Receives pattern vectors from the Ingestor.' },
      { key: 'mock_source_port', label: 'Mock Source Port', type: 'number', default: 9101, unit: 'port', desc: 'Port for the mock data source (development/demo only). Not started in production.' },
      { key: 'vector_db_endpoint', label: 'Vector DB Endpoint', type: 'string', default: 'http://localhost:8085/ingest', desc: 'Full URL the Ingestor uses to push enriched pattern vectors to the Vector Store.' },
      { key: 'deduper_endpoint',   label: 'Deduper Endpoint',   type: 'string', default: 'http://localhost:8084/ingest_block', desc: 'Full URL the WAL Shipper uses to upload completed blocks to the Deduper.' },
      { key: 'peer_nodes', label: 'Peer Nodes', type: 'array', default: [], desc: 'HA replica addresses for cross-node consistency. Leave empty for single-node deployments. Example: ["http://node2:8080","http://node3:8080"]' },
    ],
  },
  {
    key: 'data', title: 'Data Storage', icon: Database, color: T.purple,
    desc: 'Root directory for all TSDB.ai runtime data. Subdirectories for WAL, blocks, index, events, and registry are created automatically.',
    fields: [
      { key: 'root', label: 'Root Directory', type: 'string', default: './tsdb.ai-data', desc: 'Base path for all runtime data. Use an absolute path on production systems, e.g. /var/lib/tsdb.ai. All sub-paths (wal/, blocks/, index/, events/, registry/) are derived from this.' },
    ],
  },
  {
    key: 'ingestion', title: 'Ingestion Engine', icon: Zap, color: T.amber,
    desc: 'Controls how raw samples are buffered, compressed, and written to the WAL. The compression engine fits a polynomial model to each segment of samples.',
    fields: [
      { key: 'samples_per_segment',     label: 'Samples per Segment',    type: 'number', default: 100,  small: '50–100',   large: '500–1000', desc: 'Number of raw samples buffered per series before model compression is triggered.' },
      { key: 'max_samples_per_segment', label: 'Max Samples per Segment',type: 'number', default: 1000, small: '500',       large: '5000',     desc: 'Compression fires when this limit is hit regardless of samples_per_segment. Guards against very slow series that accumulate large backlogs.' },
      { key: 'rmse_tolerance',          label: 'RMSE Tolerance',         type: 'number', default: 10.0, small: '10.0',      large: '5.0–20.0', desc: 'Adaptive-fit error tolerance. Lower = more faithful reconstruction, less compression ratio. Raise for smaller storage at the cost of precision.' },
      { key: 'num_shards',              label: 'Lock Shards',            type: 'number', default: 256,  small: '16–64',     large: '512–1024', desc: 'Number of independent RWMutex shards. Must be a power of two. Higher values reduce lock contention for large metric cardinalities.' },
      { key: 'wal_batch_size',          label: 'WAL Batch Size',         type: 'number', default: 500,  small: '100',       large: '1000–5000',desc: 'WAL batch writer flushes after this many chunks…' },
      { key: 'wal_batch_interval_ms',   label: 'WAL Batch Interval (ms)',type: 'number', default: 200,  small: '500',       large: '100–200',  desc: '…or after this many milliseconds, whichever comes first.' },
      { key: 'index_sync_interval_s',   label: 'Index Sync Interval (s)',type: 'number', default: 5,    small: '5',         large: '5',        desc: 'How often the in-memory symbol index is synced to the on-disk index database.' },
    ],
  },
  {
    key: 'shipper', title: 'WAL Shipper', icon: Activity, color: T.cyan,
    desc: 'Batches completed WAL files into time-window blocks and uploads them to the Deduper. Also enforces local disk quotas.',
    fields: [
      { key: 'poll_interval_s',       label: 'Poll Interval (s)',       type: 'number', default: 10,   small: '30–60',    large: '5–10',    desc: 'How often the Shipper scans for completed WAL files ready for packaging.' },
      { key: 'block_time_window_min', label: 'Block Window (min)',       type: 'number', default: 2,    small: '5',        large: '1–2',     desc: 'Groups WAL chunks into blocks spanning this many minutes. Smaller windows = more blocks, faster query granularity.' },
      { key: 'max_retries',           label: 'Max Retries',             type: 'number', default: 5,    desc: 'Maximum HTTP retry attempts when pushing a block to the Deduper before it is put back in the queue.' },
      { key: 'initial_backoff_ms',    label: 'Initial Backoff (ms)',    type: 'number', default: 500,  desc: 'Initial retry delay in milliseconds. Doubles on each subsequent attempt (exponential back-off).' },
      { key: 'upload_workers',        label: 'Upload Workers',          type: 'number', default: 4,    small: '1–2',      large: '8–16',    desc: 'Parallel goroutines for uploading blocks to the Deduper.' },
      { key: 'upload_queue_capacity', label: 'Upload Queue Depth',      type: 'number', default: 100,  small: '20',       large: '500',     desc: 'Number of pending upload jobs buffered before back-pressure is applied.' },
      { key: 'cleanup_interval_s',    label: 'Cleanup Interval (s)',    type: 'number', default: 10,   desc: 'How often the disk-usage cleanup policy is evaluated.' },
      { key: 'disk_usage_threshold_pct', label: 'Disk Usage Threshold (%)', type: 'number', default: 90.0, desc: 'Emergency cleanup fires when disk usage reaches this percentage. Oldest blocks are deleted first until usage drops 5 pp below threshold.' },
      { key: 'max_block_age_minutes', label: 'Max Block Age (min)',     type: 'number', default: 1440, small: '60',       large: '1440',    desc: 'Blocks older than this are eligible for age-based deletion. Set to 0 to rely only on disk pressure.' },
    ],
  },
  {
    key: 'deduper', title: 'Deduplication Service', icon: Cpu, color: T.purple,
    desc: 'Receives staged blocks from the Shipper, deduplicates overlapping series, and writes canonical long-term blocks.',
    fields: [
      { key: 'retention_check_interval_min', label: 'Retention Check Interval (min)', type: 'number', default: 10,    desc: 'How often the retention policy scans canonical blocks for eviction.' },
      { key: 'max_canonical_age_minutes',    label: 'Max Canonical Age (min)',        type: 'number', default: 43200, small: '10080 (7d)', large: '129600 (90d)', desc: 'Canonical blocks older than this are deleted. 43200 = 30 days. Set to 0 to keep forever (not recommended for S3-enabled setups).' },
    ],
  },
  {
    key: 'query', title: 'Query Gateway', icon: Search, color: T.cyan,
    desc: 'Serves Prometheus-compatible queries by reconstructing time series from polynomial models. Implements a three-tier read path: memory LRU → local disk → S3.',
    fields: [
      { key: 'timeout_s',                 label: 'Query Timeout (s)',         type: 'number', default: 30,     desc: 'Per-query execution deadline. Queries that exceed this are cancelled and return an error.' },
      { key: 'synthesize_points',         label: 'Synthesized Points',        type: 'number', default: 100,   small: '50',       large: '200–500',  desc: 'Number of data points synthesized when reconstructing a series from polynomial coefficients for a given time range.' },
      { key: 'max_cache_size',            label: 'LRU Cache Size',            type: 'string', default: '500MB',small: '100MB',    large: '4GB–16GB', desc: 'Maximum memory for the query result LRU cache. Accepts "100MB", "2GB", etc.' },
      { key: 'eviction_headroom_pct',     label: 'Eviction Headroom',         type: 'number', default: 0.20,  desc: 'Proactive eviction begins when the cache reaches (1 - headroom) capacity. 0.20 = evict at 80% full.' },
      { key: 'symbol_refresh_interval_s', label: 'Symbol Refresh (s)',        type: 'number', default: 30,    desc: 'How often the metric symbol table is refreshed from the index database.' },
      { key: 'file_index_interval_s',     label: 'File Index Interval (s)',   type: 'number', default: 10,    desc: 'How often the canonical block file catalog is rescanned to discover new blocks.' },
      { key: 'lts_scan_workers',          label: 'LTS Scan Workers',          type: 'number', default: 8,     small: '2',        large: '16–32',    desc: 'Parallel goroutines for scanning LTS blocks during a query. Raise on multi-core machines handling many concurrent queries.' },
      { key: 'wasm_module_path',          label: 'WASM Module Path',          type: 'string', default: 'model_core.wasm', desc: 'Path to the WASM polynomial evaluation module. Must be accessible by the Query Gateway at startup.' },
    ],
  },
  {
    key: 'anomaly', title: 'Anomaly Detection', icon: AlertTriangle, color: T.red,
    desc: 'Compares each new model fit against historical RMSE baselines to flag deviations. Also tracks model-ID transitions for regime-change detection.',
    fields: [
      { key: 'rmse_multiplier',         label: 'RMSE Multiplier',          type: 'number', default: 3.0,  small: '2.5–3.0',  large: '3.0–5.0',  desc: 'Anomaly threshold: current_rmse > historical_mean × multiplier. Lower = more sensitive, higher = fewer false positives.' },
      { key: 'min_chunks_for_history',  label: 'Min Chunks for History',   type: 'number', default: 5,    desc: 'Minimum number of ingested chunks before anomaly detection activates for a series. Prevents false alarms during initial warm-up.' },
      { key: 'regime_history_len',      label: 'Regime History Length',    type: 'number', default: 10,   small: '5',        large: '20–50',    desc: 'Depth of the model-ID ring buffer used for regime-change detection. Longer windows require more sustained model shifts.' },
      { key: 'seasonal_slots',          label: 'Seasonal Slots',           type: 'number', default: 168,  desc: 'Number of time slots for seasonal RMSE baselines. 168 = 7 days × 24 hours. Reduce to 24 for coarser (daily) seasonality.' },
    ],
  },
  {
    key: 'patterns', title: 'Pattern Registry', icon: BookMarked, color: T.amber,
    desc: 'Stores named behaviour fingerprints (e.g. "memory_leak", "normal_deploy_ramp"). New vectors are auto-annotated when cosine similarity exceeds the match threshold.',
    fields: [
      { key: 'match_threshold',    label: 'Match Threshold',    type: 'number', default: 0.92,  small: '0.90', large: '0.95',  desc: 'Cosine similarity threshold for auto-annotating a new vector against a registered pattern.' },
      { key: 'max_registry_size',  label: 'Max Registry Size',  type: 'number', default: 500,   small: '100',  large: '5000', desc: 'Maximum number of entries in the pattern registry. Least-recently-used entries are evicted when this limit is reached.' },
      { key: 'max_age_days',       label: 'Max Age (days)',     type: 'number', default: 90,    small: '30',   large: '365',  desc: 'Patterns not matched within this many days are evicted during the age-based cleanup pass.' },
    ],
  },
  {
    key: 'causal', title: 'Causal Analysis', icon: GitBranch, color: T.purple,
    desc: 'Scans cross-metric correlations at configurable lag offsets to discover leading-indicator relationships (e.g. auth_errors → checkout_latency +45s).',
    fields: [
      { key: 'analysis_interval_s', label: 'Analysis Interval (s)',  type: 'number', default: 60,                 small: '300',      large: '30–60',  desc: 'How often the background causal analysis cycle runs.' },
      { key: 'max_edges_per_node',  label: 'Max Edges per Node',    type: 'number', default: 5,                  small: '3',        large: '10',     desc: 'Maximum outgoing causal edges per metric (fan-out cap). Prevents highly correlated metrics from dominating the graph.' },
      { key: 'edge_ttl_minutes',    label: 'Edge TTL (min)',         type: 'number', default: 10,                 small: '60',       large: '1440+',  desc: 'Causal edges not re-observed within this window are pruned. IMPORTANT: use 1440+ (1 day) in production — 10 min is demo-only.' },
      { key: 'lag_offsets_s',       label: 'Lag Offsets (s)',        type: 'array',  default: [5,10,30,60,120,300], small: '[10,30,60]', large: '[5,10,30,60,120,300,600]', desc: 'Lag offsets tested when searching for leading-indicator relationships. Should cover the typical latency range of your inter-service calls.' },
    ],
  },
  {
    key: 'vectors', title: 'Vector Store', icon: TrendingUp, color: T.cyan,
    desc: 'Stores compressed polynomial model vectors for semantic similarity search and pattern matching.',
    fields: [
      { key: 'match_threshold',        label: 'Dedup Match Threshold',   type: 'number', default: 0.99,  small: '0.99',  large: '0.995',  desc: 'Cosine score above which a new vector is considered a duplicate of an existing entry and is merged rather than inserted.' },
      { key: 'interesting_threshold',  label: 'Interesting Threshold',   type: 'number', default: 0.01,  small: '0.01',  large: '0.005',  desc: 'Vectors with change magnitude below this threshold are filtered as "boring" and not stored, keeping the vector DB lean.' },
      { key: 'ingest_queue_capacity',  label: 'Ingest Queue Depth',      type: 'number', default: 1000,  small: '100',   large: '5000',   desc: 'Async ingest queue depth for the vector store. Raise if the Ingestor logs queue-full warnings under high cardinality.' },
    ],
  },
  {
    key: 'scraper', title: 'Scraper Agent', icon: Radio, color: T.green,
    desc: 'Internal self-metric scraper. Polls the Self Exporter and forwards TSDB.ai operational metrics back into the Ingestor, closing the feedback loop.',
    fields: [
      { key: 'target_endpoint',   label: 'Target Endpoint',    type: 'string', default: 'http://localhost:9102/metrics',       desc: 'Prometheus /metrics endpoint to scrape. Points to the Self Exporter by default.' },
      { key: 'ingest_endpoint',   label: 'Ingest Endpoint',    type: 'string', default: 'http://localhost:8080/ingest_samples', desc: 'Ingestor endpoint to forward scraped samples to.' },
      { key: 'interval_s',        label: 'Scrape Interval (s)',type: 'number', default: 30,    small: '60',  large: '15–30', desc: 'How often to scrape the target endpoint.' },
      { key: 'timeout_s',         label: 'Timeout (s)',        type: 'number', default: 20,    desc: 'Per-scrape HTTP timeout in seconds.' },
      { key: 'max_buffer_bytes',  label: 'Max Buffer (bytes)', type: 'number', default: 52428800, small: '10485760 (10MB)', large: '524288000 (500MB)', desc: 'Maximum resiliency buffer size. When the ingestor is unreachable, samples are buffered here and flushed on recovery. Drops samples when full.' },
      { key: 'proxy_url',         label: 'Proxy URL',          type: 'string', default: '',    desc: 'Optional HTTP/HTTPS/SOCKS5 proxy for scrape requests. Leave empty to connect directly. Does not apply to ingestor push requests. Example: http://proxy.corp:3128' },
    ],
  },
  {
    key: 's3', title: 'S3 / Object Storage', icon: Cloud, color: T.amber,
    desc: 'Tiered long-term storage: local disk = hot short-term buffer, S3 = authoritative cold storage. The Deduper uploads every canonical block; the Query Gateway fetches on-demand.',
    fields: [
      { key: 'enabled',                    label: 'Enabled',                    type: 'boolean', default: false,   desc: 'Master switch. Set true to activate S3 upload and tiered querying.' },
      { key: 'endpoint',                   label: 'Endpoint URL',               type: 'string',  default: '',      desc: 'S3-compatible endpoint URL. Leave empty for native AWS S3 (endpoint derived from region). MinIO: http://minio:9000. Cloudflare R2: https://<acctId>.r2.cloudflarestorage.com.' },
      { key: 'region',                     label: 'Region',                     type: 'string',  default: 'us-east-1', desc: 'AWS region for request signing and default endpoint URL.' },
      { key: 'bucket',                     label: 'Bucket',                     type: 'string',  default: 'tsdb-ai-lts', desc: 'Bucket name. Must exist before starting TSDB.ai — the service does not create buckets.' },
      { key: 'prefix',                     label: 'Object Prefix',              type: 'string',  default: 'blocks/', desc: 'All block objects are stored under this prefix. Include the trailing slash. Use "" for bucket root.' },
      { key: 'access_key_id',              label: 'Access Key ID',              type: 'string',  default: '',      desc: 'AWS access key. Leave empty to read from the AWS_ACCESS_KEY_ID environment variable.' },
      { key: 'secret_access_key',          label: 'Secret Access Key',          type: 'password',default: '',      desc: 'AWS secret key. Leave empty to read from AWS_SECRET_ACCESS_KEY. Never commit credentials to config files in source control.' },
      { key: 'use_path_style',             label: 'Use Path-Style URLs',        type: 'boolean', default: false,   desc: 'Set true for MinIO and other non-AWS endpoints. Path-style: https://endpoint/bucket/key. Virtual-host (default): https://bucket.endpoint/key.' },
      { key: 'upload_workers',             label: 'Upload Workers',             type: 'number',  default: 4,       small: '2', large: '8–16', desc: 'Parallel goroutines uploading blocks to S3.' },
      { key: 'upload_queue_capacity',      label: 'Upload Queue Depth',         type: 'number',  default: 256,     small: '64', large: '1024', desc: 'Async upload queue depth. Blocks are buffered here before being uploaded.' },
      { key: 'upload_timeout_s',           label: 'Upload Timeout (s)',         type: 'number',  default: 60,      desc: 'HTTP timeout in seconds for a single S3 PutObject call.' },
      { key: 'download_timeout_s',         label: 'Download Timeout (s)',       type: 'number',  default: 30,      desc: 'HTTP timeout in seconds for a single S3 GetObject call at query time.' },
      { key: 'retention_after_upload_min', label: 'Local Retention After Upload (min)', type: 'number', default: 86400, small: '86400 (60d)', large: '10080–86400', desc: 'How long to keep a local canonical block after successful S3 upload. After this window the Deduper deletes the local copy; future queries fetch from S3. Set 0 to keep local copies forever.' },
      { key: 'multipart_threshold_mb',     label: 'Multipart Threshold (MB)',   type: 'number',  default: 100,     desc: 'Objects larger than this use multipart upload. The default handles all normal canonical blocks.' },
      { key: 'multipart_part_size_mb',     label: 'Multipart Part Size (MB)',   type: 'number',  default: 50,      desc: 'Size of each part in a multipart upload.' },
    ],
  },
  {
    key: 'forecasting', title: 'Forecasting', icon: TrendingUp, color: T.purple,
    desc: 'Extrapolates polynomial model coefficients to generate forward-looking predictions with confidence bands.',
    fields: [
      { key: 'default_horizon_s', label: 'Default Horizon (s)',  type: 'number', default: 300,   desc: 'Default forecast horizon in seconds when no horizon is specified in the request. 300 = 5 minutes.' },
      { key: 'confidence_floor',  label: 'Confidence Floor',     type: 'number', default: 0.001, desc: 'Minimum confidence band half-width. Prevents zero-width intervals on perfectly flat series.' },
    ],
  },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toYaml(formValues) {
  const lines = ['# Generated by TSDB.ai Admin Panel', `# ${new Date().toISOString()}`, '']
  SECTIONS.forEach(section => {
    lines.push(`# ${'─'.repeat(72 - section.key.length - 3)} ${section.title}`)
    lines.push(`${section.key}:`)
    section.fields.forEach(f => {
      const val = formValues[section.key]?.[f.key] ?? f.default
      const yamlVal = Array.isArray(val)
        ? `[${val.join(', ')}]`
        : typeof val === 'string'
          ? (val === '' ? '""' : `"${val}"`)
          : val
      lines.push(`  ${f.key}: ${yamlVal}`)
    })
    lines.push('')
  })
  return lines.join('\n')
}

function downloadYaml(content) {
  const blob = new Blob([content], { type: 'text/yaml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'tsdb.yaml'; a.click()
  URL.revokeObjectURL(url)
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function Tab({ label, active, onClick }) {
  const { T } = useTheme()
  return (
    <button onClick={onClick} style={{
      padding: '9px 22px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
      background: active ? `linear-gradient(135deg, ${T.purple}, ${T.cyan})` : T.bgPanel,
      color: active ? '#fff' : T.textSec,
      boxShadow: active ? glow.purple : 'none',
      transition: 'all 0.2s',
    }}>{label}</button>
  )
}

function Badge({ text, color }) {
  const { T } = useTheme()
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
      background: `${color}18`, border: `1px solid ${color}44`, color,
    }}>{text}</span>
  )
}

function ConfigField({ field, value, sectionColor }) {
  const { T } = useTheme()
  const displayVal = value === undefined || value === null ? field.default : value
  const isDefault = displayVal === field.default
  return (
    <div style={{
      padding: '12px 16px', borderRadius: 8, marginBottom: 8,
      background: T.bgPanel, border: `1px solid ${T.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: T.textPri, fontFamily: T.mono }}>
              {field.key}
            </span>
            {field.small && <Badge text={`small: ${field.small}`} color={T.green} />}
            {field.large && <Badge text={`large: ${field.large}`} color={T.purple} />}
          </div>
          <div style={{ fontSize: 12, color: T.textMut, lineHeight: 1.5 }}>{field.desc}</div>
        </div>
        <div style={{ flexShrink: 0, textAlign: 'right' }}>
          <div style={{
            fontFamily: T.mono, fontSize: 13, fontWeight: 700,
            color: isDefault ? T.textSec : sectionColor,
            background: isDefault ? `${T.border}44` : `${sectionColor}18`,
            border: `1px solid ${isDefault ? T.border : sectionColor + '44'}`,
            borderRadius: 6, padding: '4px 10px', whiteSpace: 'nowrap',
          }}>
            {Array.isArray(displayVal) ? `[${displayVal.join(', ')}]`
              : typeof displayVal === 'boolean' ? (displayVal ? 'true' : 'false')
              : displayVal === '' ? <span style={{ color: T.textMut, fontStyle: 'italic' }}>empty</span>
              : String(displayVal)}
          </div>
          {!isDefault && (
            <div style={{ fontSize: 10, color: sectionColor, marginTop: 3, opacity: 0.7 }}>
              (custom)
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionCard({ section, liveConfig, expanded, onToggle }) {
  const { T } = useTheme()
  const Icon = section.icon
  const sectionData = liveConfig?.[section.key] || {}
  return (
    <div style={{
      background: T.bgCard, borderRadius: 12, border: `1px solid ${T.border}`,
      marginBottom: 12, overflow: 'hidden',
    }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '16px 20px', cursor: 'pointer',
          borderBottom: expanded ? `1px solid ${T.border}` : 'none',
        }}
      >
        <div style={{
          width: 34, height: 34, borderRadius: 8,
          background: `${section.color}18`, border: `1px solid ${section.color}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Icon size={15} color={section.color} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.textPri }}>{section.title}</div>
          <div style={{ fontSize: 11, color: T.textMut, marginTop: 2 }}>{section.desc}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: T.textMut }}>{section.fields.length} fields</span>
          {expanded ? <ChevronUp size={14} color={T.textMut} /> : <ChevronDown size={14} color={T.textMut} />}
        </div>
      </div>
      {expanded && (
        <div style={{ padding: '14px 20px' }}>
          {section.fields.map(f => (
            <ConfigField key={f.key} field={f} value={sectionData[f.key]} sectionColor={section.color} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Generator tab ───────────────────────────────────────────────────────────

function GeneratorInput({ field, value, onChange, sectionColor }) {
  const { T } = useTheme()
  const inputStyle = {
    width: '100%', padding: '8px 11px', boxSizing: 'border-box',
    background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7,
    color: T.textPri, fontSize: 12, fontFamily: T.mono, outline: 'none',
  }
  if (field.type === 'boolean') {
    return (
      <select value={String(value ?? field.default)} onChange={e => onChange(e.target.value === 'true')} style={inputStyle}>
        <option value="false">false</option>
        <option value="true">true</option>
      </select>
    )
  }
  return (
    <input
      type={field.type === 'password' ? 'password' : 'text'}
      value={value ?? (Array.isArray(field.default) ? field.default.join(', ') : (field.default ?? ''))}
      onChange={e => {
        let v = e.target.value
        if (field.type === 'number') v = v === '' ? '' : Number(v)
        onChange(v)
      }}
      placeholder={String(field.default ?? '')}
      style={inputStyle}
    />
  )
}

function GeneratorSection({ section, values, onChange }) {
  const { T } = useTheme()
  const Icon = section.icon
  const [open, setOpen] = useState(section.key === 'server' || section.key === 'data')
  return (
    <div style={{
      background: T.bgCard, borderRadius: 12, border: `1px solid ${T.border}`,
      marginBottom: 10, overflow: 'hidden',
    }}>
      <div onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', cursor: 'pointer',
        borderBottom: open ? `1px solid ${T.border}` : 'none',
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 7,
          background: `${section.color}18`, border: `1px solid ${section.color}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={13} color={section.color} />
        </div>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: T.textPri }}>{section.title}</span>
        {open ? <ChevronUp size={13} color={T.textMut} /> : <ChevronDown size={13} color={T.textMut} />}
      </div>
      {open && (
        <div style={{ padding: '14px 18px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
          {section.fields.map(f => (
            <div key={f.key} style={{ gridColumn: f.type === 'string' || f.type === 'password' || f.type === 'array' ? 'span 2' : 'span 1' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMut, fontFamily: T.mono, marginBottom: 4 }}>
                {f.key}
              </div>
              {f.desc && <div style={{ fontSize: 10, color: T.textMut, marginBottom: 4, lineHeight: 1.4 }}>{f.desc}</div>}
              <GeneratorInput
                field={f}
                value={values?.[f.key]}
                onChange={v => onChange(section.key, f.key, v)}
                sectionColor={section.color}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────────────────

// ─── Restart banner ───────────────────────────────────────────────────────────

function RestartBanner({ onDismiss }) {
  const { T } = useTheme()
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 18px', borderRadius: 10, marginBottom: 20,
      background: '#451a03', border: '2px solid #92400e',
    }}>
      <AlertCircle size={16} color="#fbbf24" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#fef3c7' }}>
          Config saved — restart required.&nbsp;
        </span>
        <span style={{ fontSize: 12, color: '#fcd34d' }}>
          The new <code style={{ fontFamily: 'monospace' }}>tsdb.yaml</code> has been written to disk.
          Restart the TSDB.ai server process to apply changes.
        </span>
      </div>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fbbf24', display: 'flex' }}>
        <X size={14} />
      </button>
    </div>
  )
}

export default function Config() {
  const { T } = useTheme()
  const [tab, setTab] = useState('view')
  const [liveConfig, setLiveConfig] = useState(null)
  const [loading, setLoading] = useState(false)
  const [expandedSections, setExpandedSections] = useState({ server: true, data: true })
  const [formValues, setFormValues] = useState({})
  const [yamlPreview, setYamlPreview] = useState('')
  const [copied, setCopied] = useState(false)
  const [applying, setApplying] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [applyErr, setApplyErr] = useState(null)

  const loadConfig = async () => {
    setLoading(true)
    const cfg = await fetchLiveConfig()
    setLiveConfig(cfg)
    setLoading(false)
  }

  useEffect(() => { loadConfig() }, [])

  const toggleSection = key =>
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }))

  const updateFormValue = (section, key, value) => {
    setFormValues(prev => ({
      ...prev,
      [section]: { ...(prev[section] || {}), [key]: value },
    }))
  }

  const handleGenerateYaml = () => {
    const yaml = toYaml(formValues)
    setYamlPreview(yaml)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(yamlPreview)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleApply = async () => {
    if (!yamlPreview) return
    setApplying(true)
    setApplyErr(null)
    const result = await saveConfig(yamlPreview)
    setApplying(false)
    if (result?.ok) {
      setRestartRequired(true)
    } else {
      setApplyErr('Failed to save config. Is the backend running?')
    }
  }

  // Pre-fill generator from live config and switch to generate tab
  const handleEditLive = () => {
    if (!liveConfig) return
    const prefilled = {}
    SECTIONS.forEach(section => {
      const live = liveConfig[section.key]
      if (!live) return
      prefilled[section.key] = {}
      section.fields.forEach(f => {
        if (live[f.key] !== undefined) prefilled[section.key][f.key] = live[f.key]
      })
    })
    setFormValues(prefilled)
    setYamlPreview(toYaml(prefilled))
    setTab('generate')
  }

  return (
    <div style={{ padding: '28px 32px', overflowY: 'auto', flex: 1, maxWidth: 860 }}>
      {/* Restart banner */}
      {restartRequired && <RestartBanner onDismiss={() => setRestartRequired(false)} />}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri }}>Configuration</h1>
          <p style={{ fontSize: 13, color: T.textMut, marginTop: 4 }}>
            View active config or generate a new <code style={{ fontFamily: T.mono, fontSize: 12, color: T.cyan }}>tsdb.yaml</code> interactively.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Tab label="View Config"     active={tab === 'view'}     onClick={() => setTab('view')} />
          <Tab label="Generate Config" active={tab === 'generate'} onClick={() => setTab('generate')} />
        </div>
      </div>

      {/* ── View tab ── */}
      {tab === 'view' && (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', background: T.bgCard, borderRadius: 10,
            border: `1px solid ${T.border}`, marginBottom: 20,
          }}>
            <div style={{ fontSize: 12, color: T.textMut }}>
              {liveConfig
                ? <><span style={{ color: T.green }}>●</span> Live config loaded from backend</>
                : loading
                  ? <><span style={{ color: T.amber }}>●</span> Loading…</>
                  : <><span style={{ color: T.textMut }}>●</span> Backend offline — showing defaults</>
              }
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {liveConfig && (
                <button
                  onClick={handleEditLive}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 14px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${T.purple}55`, background: `${T.purple}18`, color: T.purple,
                  }}
                >
                  <Edit3 size={12} />
                  Edit &amp; Apply
                </button>
              )}
              <button
                onClick={loadConfig}
                disabled={loading}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${T.border}`, background: T.bgPanel, color: T.textSec,
                }}
              >
                <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
                Refresh
              </button>
            </div>
          </div>

          {SECTIONS.map(section => (
            <SectionCard
              key={section.key}
              section={section}
              liveConfig={liveConfig}
              expanded={!!expandedSections[section.key]}
              onToggle={() => toggleSection(section.key)}
            />
          ))}
        </>
      )}

      {/* ── Generate tab ── */}
      {tab === 'generate' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
          {/* Form */}
          <div>
            <div style={{
              fontSize: 12, color: T.textMut, marginBottom: 14, lineHeight: 1.6,
              padding: '10px 14px', background: T.bgCard, borderRadius: 8, border: `1px solid ${T.border}`,
            }}>
              Adjust any values below, then click <strong style={{ color: T.cyan }}>Generate YAML</strong>. Fields left blank use their default value.
            </div>
            {SECTIONS.map(section => (
              <GeneratorSection
                key={section.key}
                section={section}
                values={formValues[section.key]}
                onChange={updateFormValue}
              />
            ))}
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button
                onClick={handleGenerateYaml}
                style={{
                  flex: 1, padding: '11px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  background: `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
                  color: '#fff', boxShadow: glow.purple,
                }}
              >
                <Settings size={14} style={{ verticalAlign: 'middle', marginRight: 7 }} />
                Generate YAML
              </button>
              {yamlPreview && (
                <button
                  onClick={handleApply}
                  disabled={applying}
                  style={{
                    flex: 1, padding: '11px 0', borderRadius: 8, border: `2px solid ${T.amber}55`,
                    cursor: applying ? 'default' : 'pointer', fontSize: 13, fontWeight: 600,
                    background: applying ? T.bgPanel : `${T.amber}18`,
                    color: applying ? T.textMut : T.amber,
                  }}
                >
                  <Upload size={14} style={{ verticalAlign: 'middle', marginRight: 7 }} />
                  {applying ? 'Saving…' : 'Apply to Server'}
                </button>
              )}
            </div>
            {applyErr && (
              <div style={{ marginTop: 8, fontSize: 11, color: T.red, padding: '8px 12px', background: `${T.red}11`, borderRadius: 6 }}>
                {applyErr}
              </div>
            )}
          </div>

          {/* Preview */}
          <div style={{ position: 'sticky', top: 20 }}>
            <div style={{
              background: T.bgCard, borderRadius: 12,
              border: `1px solid ${T.border}`, overflow: 'hidden',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', borderBottom: `1px solid ${T.border}`,
              }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: T.textPri, fontFamily: T.mono }}>tsdb.yaml</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {yamlPreview && (
                    <>
                      <button
                        onClick={handleCopy}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '5px 12px', borderRadius: 6, border: `1px solid ${T.border}`,
                          background: T.bgPanel, color: T.textSec, fontSize: 11, cursor: 'pointer',
                        }}
                      >
                        {copied ? <Check size={11} color={T.green} /> : null}
                        {copied ? 'Copied!' : 'Copy'}
                      </button>
                      <button
                        onClick={() => downloadYaml(yamlPreview)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '5px 12px', borderRadius: 6, border: `1px solid ${T.border}`,
                          background: T.bgPanel, color: T.textSec, fontSize: 11, cursor: 'pointer',
                        }}
                      >
                        <Download size={11} />
                        Download
                      </button>
                      <button
                        onClick={handleApply}
                        disabled={applying}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '5px 12px', borderRadius: 6, border: 'none',
                          background: applying ? T.bgPanel : `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
                          color: applying ? T.textMut : '#fff', fontSize: 11, fontWeight: 600, cursor: applying ? 'default' : 'pointer',
                        }}
                      >
                        <Upload size={11} />
                        {applying ? 'Saving…' : 'Apply to Server'}
                      </button>
                    </>
                  )}
                  {applyErr && (
                    <span style={{ fontSize: 11, color: T.red }}>{applyErr}</span>
                  )}
                </div>
              </div>
              <pre style={{
                margin: 0, padding: '16px', maxHeight: 600,
                overflowY: 'auto', overflowX: 'auto',
                fontFamily: T.mono, fontSize: 11, lineHeight: 1.7,
                color: yamlPreview ? T.textSec : T.textMut,
                background: T.bgInput,
              }}>
                {yamlPreview || '# Click "Generate YAML" to preview your config here.'}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
