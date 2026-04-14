package main

// =============================================================================
// TSDB.ai Global Configuration
//
// This file is compiled into EVERY TSDB.ai binary (ingestor, shipper, deduper,
// query gateway, vector service, exporter, scraper).  It must only import
// stdlib so it remains dependency-free.
//
// On startup each binary calls LoadConfig("tsdb.yaml").  If the file is absent
// the built-in defaults (identical to the previous hard-coded constants) are
// used, so no config file is required to run.
//
// All on-disk path vars (DataRoot, WALChunksDir, …) live here so there is
// exactly one place to update when the data root changes.
// =============================================================================

import (
	"fmt"
	"io/ioutil"
	"os"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Config structs
// ---------------------------------------------------------------------------

// TSDBConfig is the top-level config object, populated by LoadConfig().
type TSDBConfig struct {
	LicenseKey    string              `json:"license_key"`
	Server        ServerConfig        `json:"server"`
	Data          DataConfig          `json:"data"`
	Ingestion     IngestionConfig     `json:"ingestion"`
	Shipper       ShipperConfig       `json:"shipper"`
	Deduper       DeduperConfig       `json:"deduper"`
	Query         QueryConfig         `json:"query"`
	Anomaly       AnomalyConfig       `json:"anomaly"`
	Patterns      PatternsConfig      `json:"patterns"`
	Causal        CausalConfig        `json:"causal"`
	Relationships RelationshipsConfig `json:"relationships"`
	Vectors       VectorsConfig       `json:"vectors"`
	Scraper       ScraperConfig       `json:"scraper"`
	Forecasting   ForecastingConfig   `json:"forecasting"`
	S3            S3Config            `json:"s3"`
	Alerts        AlertsConfig        `json:"alerts"`
}

// AlertsConfig controls the alert evaluation engine.
type AlertsConfig struct {
	// MaxEvents is the FIFO cap on stored alert events.  Oldest are dropped
	// when this limit is reached.  Default: 500.
	MaxEvents int `json:"max_events"`
	// EvalIntervalS is how often (seconds) all enabled rules are evaluated.
	// Default: 30.
	EvalIntervalS int `json:"eval_interval_s"`
	// CooldownMinutes prevents the same rule from firing more than once per
	// window per metric.  Default: 5.
	CooldownMinutes int `json:"cooldown_minutes"`
}

type ServerConfig struct {
	IngestPort       int      `json:"ingest_port"`
	QueryPort        int      `json:"query_port"`
	DeduperPort      int      `json:"deduper_port"`
	ExporterPort     int      `json:"exporter_port"`
	MockSourcePort   int      `json:"mock_source_port"`
	VectorPort       int      `json:"vector_port"`
	VectorDBEndpoint string   `json:"vector_db_endpoint"`
	DeduperEndpoint  string   `json:"deduper_endpoint"`
	PeerNodes        []string `json:"peer_nodes"`
}

type DataConfig struct {
	Root string `json:"root"`
}

type IngestionConfig struct {
	SamplesPerSegment    int     `json:"samples_per_segment"`
	MaxSamplesPerSegment int     `json:"max_samples_per_segment"`
	RmseTolerance        float64 `json:"rmse_tolerance"`
	NumShards            int     `json:"num_shards"`
	WALBatchSize         int     `json:"wal_batch_size"`
	WALBatchIntervalMs   int     `json:"wal_batch_interval_ms"`
	IndexSyncIntervalS   int     `json:"index_sync_interval_s"`
}

type ShipperConfig struct {
	PollIntervalS         int     `json:"poll_interval_s"`
	BlockTimeWindowMin    int     `json:"block_time_window_min"`
	MaxRetries            int     `json:"max_retries"`
	InitialBackoffMs      int     `json:"initial_backoff_ms"`
	UploadWorkers         int     `json:"upload_workers"`
	UploadQueueCapacity   int     `json:"upload_queue_capacity"`
	CleanupIntervalS      int     `json:"cleanup_interval_s"`
	DiskUsageThresholdPct float64 `json:"disk_usage_threshold_pct"`
	MaxBlockAgeMinutes    int     `json:"max_block_age_minutes"`
}

type DeduperConfig struct {
	RetentionCheckIntervalMin int `json:"retention_check_interval_min"`
	MaxCanonicalAgeMinutes    int `json:"max_canonical_age_minutes"`
}

type QueryConfig struct {
	TimeoutS               int     `json:"timeout_s"`
	SynthesizePoints       int     `json:"synthesize_points"`
	MaxCacheSize           string  `json:"max_cache_size"`
	EvictionHeadroomPct    float64 `json:"eviction_headroom_pct"`
	SymbolRefreshIntervalS int     `json:"symbol_refresh_interval_s"`
	FileIndexIntervalS     int     `json:"file_index_interval_s"`
	LTSScanWorkers         int     `json:"lts_scan_workers"`
	WasmModulePath         string  `json:"wasm_module_path"`
	HeadNodeURL            string  `json:"head_node_url"`
	IndexNodeURL           string  `json:"index_node_url"`
}

type AnomalyConfig struct {
	RmseMultiplier      float64 `json:"rmse_multiplier"`
	MinChunksForHistory int     `json:"min_chunks_for_history"`
	RegimeHistoryLen    int     `json:"regime_history_len"`
	SeasonalSlots       int     `json:"seasonal_slots"`
}

type PatternsConfig struct {
	MatchThreshold  float64 `json:"match_threshold"`
	MaxRegistrySize int     `json:"max_registry_size"`
	MaxAgeDays      int     `json:"max_age_days"`
}

type CausalConfig struct {
	AnalysisIntervalS int   `json:"analysis_interval_s"`
	MaxEdgesPerNode   int   `json:"max_edges_per_node"`
	EdgeTTLMinutes    int   `json:"edge_ttl_minutes"`
	LagOffsetsS       []int `json:"lag_offsets_s"`
}

type RelationshipsConfig struct {
	ScanIntervalS  int     `json:"scan_interval_s"`
	MinScore       float64 `json:"min_score"`
	MaxEdgesTotal  int     `json:"max_edges_total"`
	EdgeTTLMinutes int     `json:"edge_ttl_minutes"`
}

type VectorsConfig struct {
	MatchThreshold       float64 `json:"match_threshold"`
	InterestingThreshold float64 `json:"interesting_threshold"`
	IngestQueueCapacity  int     `json:"ingest_queue_capacity"`
}

type ScraperConfig struct {
	TargetEndpoint string `json:"target_endpoint"`
	IngestEndpoint string `json:"ingest_endpoint"`
	IntervalS      int    `json:"interval_s"`
	TimeoutS       int    `json:"timeout_s"`
	MaxBufferBytes int    `json:"max_buffer_bytes"`
	// ProxyURL is an optional HTTP/HTTPS/SOCKS5 proxy for scrape requests.
	// Leave empty to connect directly. Example: "http://proxy.corp:3128"
	// or "socks5://user:pass@proxy.corp:1080".
	// Does NOT apply to ingestor push requests (those stay on the local network).
	ProxyURL string `json:"proxy_url"`
}

type ForecastingConfig struct {
	DefaultHorizonS float64 `json:"default_horizon_s"`
	ConfidenceFloor float64 `json:"confidence_floor"`
}

// S3Config controls object-storage (S3-compatible) long-term storage.
// When Enabled=true the deduper uploads every canonical block to S3 after
// writing it locally, and the query gateway transparently fetches blocks
// from S3 when the local copy has been evicted.
type S3Config struct {
	Enabled         bool   `json:"enabled"`
	Endpoint        string `json:"endpoint"`         // empty = native AWS
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	Prefix          string `json:"prefix"`           // key prefix, e.g. "blocks/"
	AccessKeyID     string `json:"access_key_id"`    // falls back to $AWS_ACCESS_KEY_ID
	SecretAccessKey string `json:"secret_access_key"`// falls back to $AWS_SECRET_ACCESS_KEY
	UsePathStyle    bool   `json:"use_path_style"`   // true for MinIO

	UploadWorkers       int `json:"upload_workers"`
	UploadQueueCapacity int `json:"upload_queue_capacity"`
	UploadTimeoutS      int `json:"upload_timeout_s"`
	DownloadTimeoutS    int `json:"download_timeout_s"`

	// How long (minutes) to keep a local canonical block after upload.
	RetentionAfterUploadMin int `json:"retention_after_upload_min"`

	// Multipart upload thresholds.
	MultipartThresholdMB int `json:"multipart_threshold_mb"`
	MultipartPartSizeMB  int `json:"multipart_part_size_mb"`
}

// ---------------------------------------------------------------------------
// Global config instance — pre-populated with defaults
// ---------------------------------------------------------------------------

// Cfg is the live config for this process.  Read it anywhere; write only
// from LoadConfig() during startup.
var Cfg = defaultConfig()

func defaultConfig() TSDBConfig {
	return TSDBConfig{
		Server: ServerConfig{
			IngestPort:       8080,
			QueryPort:        8081,
			DeduperPort:      8084,
			ExporterPort:     9102,
			MockSourcePort:   9101,
			VectorPort:       8085,
			VectorDBEndpoint: "http://localhost:8085/ingest",
			DeduperEndpoint:  "http://localhost:8084/ingest_block",
			PeerNodes:        []string{},
		},
		Data: DataConfig{
			Root: "./tsdb.ai-data",
		},
		Ingestion: IngestionConfig{
			SamplesPerSegment:    100,
			MaxSamplesPerSegment: 1000,
			RmseTolerance:        10.0,
			NumShards:            256,
			WALBatchSize:         500,
			WALBatchIntervalMs:   200,
			IndexSyncIntervalS:   5,
		},
		Shipper: ShipperConfig{
			PollIntervalS:         10,
			BlockTimeWindowMin:    2,
			MaxRetries:            5,
			InitialBackoffMs:      500,
			UploadWorkers:         4,
			UploadQueueCapacity:   100,
			CleanupIntervalS:      10,
			DiskUsageThresholdPct: 90.0,
			MaxBlockAgeMinutes:    1440, // 1 day (was demo 1 min)
		},
		Deduper: DeduperConfig{
			RetentionCheckIntervalMin: 10,
			MaxCanonicalAgeMinutes:    43200, // 30 days
		},
		Query: QueryConfig{
			TimeoutS:               30,
			SynthesizePoints:       100,
			MaxCacheSize:           "500MB",
			EvictionHeadroomPct:    0.20,
			SymbolRefreshIntervalS: 30,
			FileIndexIntervalS:     10,
			LTSScanWorkers:         8,
			WasmModulePath:         "model_core.wasm",
			HeadNodeURL:            "http://localhost:8080",
			IndexNodeURL:           "http://localhost:8083",
		},
		Anomaly: AnomalyConfig{
			RmseMultiplier:      3.0,
			MinChunksForHistory: 5,
			RegimeHistoryLen:    10,
			SeasonalSlots:       168,
		},
		Patterns: PatternsConfig{
			MatchThreshold:  0.92,
			MaxRegistrySize: 500,
			MaxAgeDays:      90,
		},
		Causal: CausalConfig{
			AnalysisIntervalS: 60,
			MaxEdgesPerNode:   5,
			EdgeTTLMinutes:    10,
			LagOffsetsS:       []int{5, 10, 30, 60, 120, 300},
		},
		Relationships: RelationshipsConfig{
			ScanIntervalS:  90,
			MinScore:       0.85,
			MaxEdgesTotal:  5000,
			EdgeTTLMinutes: 10,
		},
		Vectors: VectorsConfig{
			MatchThreshold:       0.99,
			InterestingThreshold: 0.01,
			IngestQueueCapacity:  1000,
		},
		Scraper: ScraperConfig{
			TargetEndpoint: "http://localhost:9102/metrics",
			IngestEndpoint: "http://localhost:8080/ingest_samples",
			IntervalS:      30,
			TimeoutS:       20,
			MaxBufferBytes: 50 * 1024 * 1024, // 50 MB
		},
		Forecasting: ForecastingConfig{
			DefaultHorizonS: 300.0,
			ConfidenceFloor: 0.001,
		},
		Alerts: AlertsConfig{
			MaxEvents:       500,
			EvalIntervalS:   30,
			CooldownMinutes: 5,
		},
		S3: S3Config{
			Enabled:                 false,
			Endpoint:                "",
			Region:                  "us-east-1",
			Bucket:                  "tsdb-ai-lts",
			Prefix:                  "blocks/",
			AccessKeyID:             "",
			SecretAccessKey:         "",
			UsePathStyle:            false,
			UploadWorkers:           4,
			UploadQueueCapacity:     256,
			UploadTimeoutS:          60,
			DownloadTimeoutS:        30,
			RetentionAfterUploadMin: 86400, // 60 days — canonical blocks are tiny
			MultipartThresholdMB:    100,
			MultipartPartSizeMB:     50,
		},
	}
}

// ---------------------------------------------------------------------------
// On-disk path vars — derived from Cfg.Data.Root by initPaths()
// Centralised here so every binary gets the same path logic.
// ---------------------------------------------------------------------------

var (
	DataRoot            = "./tsdb.ai-data"
	WALChunksDir        = DataRoot + "/wal"
	ShippedDir          = DataRoot + "/blocks/staging"
	CanonicalBlocksDir  = DataRoot + "/blocks/canonical"
	LTSIndexStoragePath = DataRoot + "/index"
	CheckpointFile      = DataRoot + "/checkpoint.json"
	ANOMALY_DIR         = DataRoot + "/events/anomalies"
	REGIME_CHANGE_DIR   = DataRoot + "/events/regimes"

	// Registry JSON files (written by ingestor only; read by MCP server)
	PatternRegistryFile   = DataRoot + "/registry/patterns.json"
	CausalGraphFile       = DataRoot + "/registry/causal.json"
	RelationshipGraphFile = DataRoot + "/registry/relationships.json"

	// S3 upload manifest — tracks which canonical blocks have been uploaded
	// to object storage and whether the local copy has been evicted.
	S3ManifestFile = DataRoot + "/index/s3_manifest.json"

	// Alert engine — rules + event ring-buffer
	AlertRulesFile  = DataRoot + "/alerts/rules.json"
	AlertEventsFile = DataRoot + "/alerts/events.json"
)

func initPaths() {
	r := Cfg.Data.Root
	DataRoot            = r
	WALChunksDir        = r + "/wal"
	ShippedDir          = r + "/blocks/staging"
	CanonicalBlocksDir  = r + "/blocks/canonical"
	LTSIndexStoragePath = r + "/index"
	CheckpointFile      = r + "/checkpoint.json"
	ANOMALY_DIR         = r + "/events/anomalies"
	REGIME_CHANGE_DIR   = r + "/events/regimes"
	PatternRegistryFile   = r + "/registry/patterns.json"
	CausalGraphFile       = r + "/registry/causal.json"
	RelationshipGraphFile = r + "/registry/relationships.json"
	S3ManifestFile        = r + "/index/s3_manifest.json"
	AlertRulesFile        = r + "/alerts/rules.json"
	AlertEventsFile       = r + "/alerts/events.json"
}

// ---------------------------------------------------------------------------
// LoadConfig reads tsdb.yaml and overrides Cfg fields.
// Accepts an optional path; if the file does not exist the built-in defaults
// remain in effect and a notice is printed.
// Must be called before any other initialisation.
// ---------------------------------------------------------------------------

func LoadConfig(path string) {
	data, err := ioutil.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Printf("[CONFIG] %s not found — using built-in defaults\n", path)
		} else {
			fmt.Printf("[CONFIG] WARNING: could not read %s: %v — using defaults\n", path, err)
		}
		initPaths()
		return
	}

	doc := parseYAML(data)

	// ── server ────────────────────────────────────────────────────────────
	s := &Cfg.Server
	s.IngestPort       = doc.getInt("server", "ingest_port", s.IngestPort)
	s.QueryPort        = doc.getInt("server", "query_port", s.QueryPort)
	s.DeduperPort      = doc.getInt("server", "deduper_port", s.DeduperPort)
	s.ExporterPort     = doc.getInt("server", "exporter_port", s.ExporterPort)
	s.MockSourcePort   = doc.getInt("server", "mock_source_port", s.MockSourcePort)
	s.VectorPort       = doc.getInt("server", "vector_port", s.VectorPort)
	s.VectorDBEndpoint = doc.getString("server", "vector_db_endpoint", s.VectorDBEndpoint)
	s.DeduperEndpoint  = doc.getString("server", "deduper_endpoint", s.DeduperEndpoint)
	s.PeerNodes        = doc.getStringSlice("server", "peer_nodes", s.PeerNodes)

	// ── license ───────────────────────────────────────────────────────────
	Cfg.LicenseKey = doc.getString("license", "key", Cfg.LicenseKey)

	// ── data ──────────────────────────────────────────────────────────────
	Cfg.Data.Root = doc.getString("data", "root", Cfg.Data.Root)

	// ── ingestion ─────────────────────────────────────────────────────────
	i := &Cfg.Ingestion
	i.SamplesPerSegment    = doc.getInt("ingestion", "samples_per_segment", i.SamplesPerSegment)
	i.MaxSamplesPerSegment = doc.getInt("ingestion", "max_samples_per_segment", i.MaxSamplesPerSegment)
	i.RmseTolerance        = doc.getFloat("ingestion", "rmse_tolerance", i.RmseTolerance)
	i.NumShards            = doc.getInt("ingestion", "num_shards", i.NumShards)
	i.WALBatchSize         = doc.getInt("ingestion", "wal_batch_size", i.WALBatchSize)
	i.WALBatchIntervalMs   = doc.getInt("ingestion", "wal_batch_interval_ms", i.WALBatchIntervalMs)
	i.IndexSyncIntervalS   = doc.getInt("ingestion", "index_sync_interval_s", i.IndexSyncIntervalS)

	// ── shipper ───────────────────────────────────────────────────────────
	sh := &Cfg.Shipper
	sh.PollIntervalS         = doc.getInt("shipper", "poll_interval_s", sh.PollIntervalS)
	sh.BlockTimeWindowMin    = doc.getInt("shipper", "block_time_window_min", sh.BlockTimeWindowMin)
	sh.MaxRetries            = doc.getInt("shipper", "max_retries", sh.MaxRetries)
	sh.InitialBackoffMs      = doc.getInt("shipper", "initial_backoff_ms", sh.InitialBackoffMs)
	sh.UploadWorkers         = doc.getInt("shipper", "upload_workers", sh.UploadWorkers)
	sh.UploadQueueCapacity   = doc.getInt("shipper", "upload_queue_capacity", sh.UploadQueueCapacity)
	sh.CleanupIntervalS      = doc.getInt("shipper", "cleanup_interval_s", sh.CleanupIntervalS)
	sh.DiskUsageThresholdPct = doc.getFloat("shipper", "disk_usage_threshold_pct", sh.DiskUsageThresholdPct)
	sh.MaxBlockAgeMinutes    = doc.getInt("shipper", "max_block_age_minutes", sh.MaxBlockAgeMinutes)

	// ── deduper ───────────────────────────────────────────────────────────
	d := &Cfg.Deduper
	d.RetentionCheckIntervalMin = doc.getInt("deduper", "retention_check_interval_min", d.RetentionCheckIntervalMin)
	d.MaxCanonicalAgeMinutes    = doc.getInt("deduper", "max_canonical_age_minutes", d.MaxCanonicalAgeMinutes)

	// ── query ─────────────────────────────────────────────────────────────
	q := &Cfg.Query
	q.TimeoutS               = doc.getInt("query", "timeout_s", q.TimeoutS)
	q.SynthesizePoints       = doc.getInt("query", "synthesize_points", q.SynthesizePoints)
	q.MaxCacheSize           = doc.getString("query", "max_cache_size", q.MaxCacheSize)
	q.EvictionHeadroomPct    = doc.getFloat("query", "eviction_headroom_pct", q.EvictionHeadroomPct)
	q.SymbolRefreshIntervalS = doc.getInt("query", "symbol_refresh_interval_s", q.SymbolRefreshIntervalS)
	q.FileIndexIntervalS     = doc.getInt("query", "file_index_interval_s", q.FileIndexIntervalS)
	q.LTSScanWorkers         = doc.getInt("query", "lts_scan_workers", q.LTSScanWorkers)
	q.WasmModulePath         = doc.getString("query", "wasm_module_path", q.WasmModulePath)
	q.HeadNodeURL            = doc.getString("query", "head_node_url", q.HeadNodeURL)
	q.IndexNodeURL           = doc.getString("query", "index_node_url", q.IndexNodeURL)

	// ── anomaly ───────────────────────────────────────────────────────────
	an := &Cfg.Anomaly
	an.RmseMultiplier      = doc.getFloat("anomaly", "rmse_multiplier", an.RmseMultiplier)
	an.MinChunksForHistory = doc.getInt("anomaly", "min_chunks_for_history", an.MinChunksForHistory)
	an.RegimeHistoryLen    = doc.getInt("anomaly", "regime_history_len", an.RegimeHistoryLen)
	an.SeasonalSlots       = doc.getInt("anomaly", "seasonal_slots", an.SeasonalSlots)

	// ── patterns ──────────────────────────────────────────────────────────
	p := &Cfg.Patterns
	p.MatchThreshold  = doc.getFloat("patterns", "match_threshold", p.MatchThreshold)
	p.MaxRegistrySize = doc.getInt("patterns", "max_registry_size", p.MaxRegistrySize)
	p.MaxAgeDays      = doc.getInt("patterns", "max_age_days", p.MaxAgeDays)

	// ── causal ────────────────────────────────────────────────────────────
	c := &Cfg.Causal
	c.AnalysisIntervalS = doc.getInt("causal", "analysis_interval_s", c.AnalysisIntervalS)
	c.MaxEdgesPerNode   = doc.getInt("causal", "max_edges_per_node", c.MaxEdgesPerNode)
	c.EdgeTTLMinutes    = doc.getInt("causal", "edge_ttl_minutes", c.EdgeTTLMinutes)
	c.LagOffsetsS       = doc.getIntSlice("causal", "lag_offsets_s", c.LagOffsetsS)

	// ── relationships ─────────────────────────────────────────────────────
	rel := &Cfg.Relationships
	rel.ScanIntervalS  = doc.getInt("relationships", "scan_interval_s", rel.ScanIntervalS)
	rel.MinScore       = doc.getFloat("relationships", "min_score", rel.MinScore)
	rel.MaxEdgesTotal  = doc.getInt("relationships", "max_edges_total", rel.MaxEdgesTotal)
	rel.EdgeTTLMinutes = doc.getInt("relationships", "edge_ttl_minutes", rel.EdgeTTLMinutes)

	// ── vectors ───────────────────────────────────────────────────────────
	v := &Cfg.Vectors
	v.MatchThreshold       = doc.getFloat("vectors", "match_threshold", v.MatchThreshold)
	v.InterestingThreshold = doc.getFloat("vectors", "interesting_threshold", v.InterestingThreshold)
	v.IngestQueueCapacity  = doc.getInt("vectors", "ingest_queue_capacity", v.IngestQueueCapacity)

	// ── scraper ───────────────────────────────────────────────────────────
	sc := &Cfg.Scraper
	sc.TargetEndpoint = doc.getString("scraper", "target_endpoint", sc.TargetEndpoint)
	sc.IngestEndpoint = doc.getString("scraper", "ingest_endpoint", sc.IngestEndpoint)
	sc.IntervalS      = doc.getInt("scraper", "interval_s", sc.IntervalS)
	sc.TimeoutS       = doc.getInt("scraper", "timeout_s", sc.TimeoutS)
	sc.MaxBufferBytes = doc.getInt("scraper", "max_buffer_bytes", sc.MaxBufferBytes)

	// ── forecasting ───────────────────────────────────────────────────────
	f := &Cfg.Forecasting
	f.DefaultHorizonS = doc.getFloat("forecasting", "default_horizon_s", f.DefaultHorizonS)
	f.ConfidenceFloor = doc.getFloat("forecasting", "confidence_floor", f.ConfidenceFloor)

	// ── alerts ────────────────────────────────────────────────────────────
	al := &Cfg.Alerts
	al.MaxEvents       = doc.getInt("alerts", "max_events",        al.MaxEvents)
	al.EvalIntervalS   = doc.getInt("alerts", "eval_interval_s",   al.EvalIntervalS)
	al.CooldownMinutes = doc.getInt("alerts", "cooldown_minutes",  al.CooldownMinutes)

	// ── s3 ────────────────────────────────────────────────────────────────
	s3 := &Cfg.S3
	s3.Enabled                 = doc.getBool("s3", "enabled", s3.Enabled)
	s3.Endpoint                = doc.getString("s3", "endpoint", s3.Endpoint)
	s3.Region                  = doc.getString("s3", "region", s3.Region)
	s3.Bucket                  = doc.getString("s3", "bucket", s3.Bucket)
	s3.Prefix                  = doc.getString("s3", "prefix", s3.Prefix)
	s3.AccessKeyID             = doc.getString("s3", "access_key_id", s3.AccessKeyID)
	s3.SecretAccessKey         = doc.getString("s3", "secret_access_key", s3.SecretAccessKey)
	s3.UsePathStyle            = doc.getBool("s3", "use_path_style", s3.UsePathStyle)
	s3.UploadWorkers           = doc.getInt("s3", "upload_workers", s3.UploadWorkers)
	s3.UploadQueueCapacity     = doc.getInt("s3", "upload_queue_capacity", s3.UploadQueueCapacity)
	s3.UploadTimeoutS          = doc.getInt("s3", "upload_timeout_s", s3.UploadTimeoutS)
	s3.DownloadTimeoutS        = doc.getInt("s3", "download_timeout_s", s3.DownloadTimeoutS)
	s3.RetentionAfterUploadMin = doc.getInt("s3", "retention_after_upload_min", s3.RetentionAfterUploadMin)
	s3.MultipartThresholdMB    = doc.getInt("s3", "multipart_threshold_mb", s3.MultipartThresholdMB)
	s3.MultipartPartSizeMB     = doc.getInt("s3", "multipart_part_size_mb", s3.MultipartPartSizeMB)

	// Recompute derived paths after data.root may have changed
	initPaths()

	// Detailed config summary is printed by PrintBanner() in banner.go after
	// each service calls LoadConfig().  Keep this line for non-interactive runs.
	fmt.Printf("[CONFIG] Loaded %s  (data root: %s)\n", path, DataRoot)
}

// ---------------------------------------------------------------------------
// Minimal YAML parser — handles the subset needed by tsdb.yaml:
//   sections, scalar key:value, inline lists [a, b, c], # comments
// ---------------------------------------------------------------------------

// yamlDoc is a two-level map: section name → (key → raw string value).
type yamlDoc map[string]map[string]string

func parseYAML(data []byte) yamlDoc {
	doc := make(yamlDoc)
	currentSection := ""

	for _, rawLine := range strings.Split(string(data), "\n") {
		// Strip inline comments and trailing whitespace
		line := rawLine
		if idx := strings.Index(line, " #"); idx >= 0 {
			line = line[:idx]
		}
		line = strings.TrimRight(line, " \t\r")

		if line == "" {
			continue
		}

		// Measure indent to distinguish section headers from key-value pairs
		trimmed := strings.TrimLeft(line, " \t")
		indent := len(line) - len(trimmed)

		if indent == 0 {
			// Top-level section header: "section_name:"
			if strings.HasSuffix(trimmed, ":") && !strings.Contains(trimmed, " ") {
				currentSection = strings.TrimSuffix(trimmed, ":")
				doc[currentSection] = make(map[string]string)
			}
			continue
		}

		// Indented key: value pair
		if currentSection == "" {
			continue
		}
		colonIdx := strings.Index(trimmed, ":")
		if colonIdx < 0 {
			continue
		}
		key := strings.TrimSpace(trimmed[:colonIdx])
		val := strings.TrimSpace(trimmed[colonIdx+1:])

		// Strip trailing inline comment on the value itself
		if idx := strings.Index(val, " #"); idx >= 0 {
			val = strings.TrimSpace(val[:idx])
		}
		// Strip surrounding quotes
		if len(val) >= 2 && val[0] == '"' && val[len(val)-1] == '"' {
			val = val[1 : len(val)-1]
		}
		doc[currentSection][key] = val
	}
	return doc
}

// --- Typed accessors with defaults ------------------------------------------

func (d yamlDoc) getString(section, key, def string) string {
	if sec, ok := d[section]; ok {
		if v, ok := sec[key]; ok && v != "" {
			return v
		}
	}
	return def
}

func (d yamlDoc) getInt(section, key string, def int) int {
	if sec, ok := d[section]; ok {
		if v, ok := sec[key]; ok && v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				return n
			}
		}
	}
	return def
}

func (d yamlDoc) getFloat(section, key string, def float64) float64 {
	if sec, ok := d[section]; ok {
		if v, ok := sec[key]; ok && v != "" {
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				return f
			}
		}
	}
	return def
}

// getIntSlice parses an inline YAML sequence: [5, 10, 30] → []int{5,10,30}
func (d yamlDoc) getIntSlice(section, key string, def []int) []int {
	if sec, ok := d[section]; ok {
		if v, ok := sec[key]; ok && v != "" {
			v = strings.TrimSpace(v)
			if v == "[]" {
				return []int{}
			}
			v = strings.TrimPrefix(v, "[")
			v = strings.TrimSuffix(v, "]")
			parts := strings.Split(v, ",")
			result := make([]int, 0, len(parts))
			for _, p := range parts {
				p = strings.TrimSpace(p)
				if n, err := strconv.Atoi(p); err == nil {
					result = append(result, n)
				}
			}
			if len(result) > 0 {
				return result
			}
		}
	}
	return def
}

func (d yamlDoc) getBool(section, key string, def bool) bool {
	if sec, ok := d[section]; ok {
		if v, ok := sec[key]; ok && v != "" {
			switch strings.ToLower(strings.TrimSpace(v)) {
			case "true", "yes", "1":
				return true
			case "false", "no", "0":
				return false
			}
		}
	}
	return def
}

// getStringSlice parses an inline YAML sequence: ["a", "b"] → []string{"a","b"}
func (d yamlDoc) getStringSlice(section, key string, def []string) []string {
	if sec, ok := d[section]; ok {
		if v, ok := sec[key]; ok && v != "" {
			v = strings.TrimSpace(v)
			if v == "[]" {
				return []string{}
			}
			v = strings.TrimPrefix(v, "[")
			v = strings.TrimSuffix(v, "]")
			parts := strings.Split(v, ",")
			result := make([]string, 0, len(parts))
			for _, p := range parts {
				p = strings.TrimSpace(p)
				p = strings.Trim(p, `"'`)
				if p != "" {
					result = append(result, p)
				}
			}
			if len(result) > 0 {
				return result
			}
		}
	}
	return def
}

// ---------------------------------------------------------------------------
// Convenience duration helpers used by service code
// ---------------------------------------------------------------------------

func (c *CausalConfig) EdgeTTL() time.Duration {
	return time.Duration(c.EdgeTTLMinutes) * time.Minute
}

func (r *RelationshipsConfig) EdgeTTL() time.Duration {
	return time.Duration(r.EdgeTTLMinutes) * time.Minute
}

func (i *IngestionConfig) WALBatchInterval() time.Duration {
	return time.Duration(i.WALBatchIntervalMs) * time.Millisecond
}

func (i *IngestionConfig) IndexSyncInterval() time.Duration {
	return time.Duration(i.IndexSyncIntervalS) * time.Second
}

func (sh *ShipperConfig) CleanupInterval() time.Duration {
	return time.Duration(sh.CleanupIntervalS) * time.Second
}

func (d *DeduperConfig) RetentionCheckInterval() time.Duration {
	return time.Duration(d.RetentionCheckIntervalMin) * time.Minute
}

func (q *QueryConfig) SymbolRefreshInterval() time.Duration {
	return time.Duration(q.SymbolRefreshIntervalS) * time.Second
}

func (q *QueryConfig) FileIndexInterval() time.Duration {
	return time.Duration(q.FileIndexIntervalS) * time.Second
}

func (c *CausalConfig) AnalysisInterval() time.Duration {
	return time.Duration(c.AnalysisIntervalS) * time.Second
}

func (r *RelationshipsConfig) ScanInterval() time.Duration {
	return time.Duration(r.ScanIntervalS) * time.Second
}

func (sh *ShipperConfig) PollInterval() time.Duration {
	return time.Duration(sh.PollIntervalS) * time.Second
}

func (s *S3Config) UploadTimeout() time.Duration {
	return time.Duration(s.UploadTimeoutS) * time.Second
}

func (s *S3Config) DownloadTimeout() time.Duration {
	return time.Duration(s.DownloadTimeoutS) * time.Second
}

func (s *S3Config) RetentionAfterUpload() time.Duration {
	return time.Duration(s.RetentionAfterUploadMin) * time.Minute
}

// ResolvedEndpoint returns the effective S3 endpoint URL.
// Falls back to the standard AWS regional endpoint when Endpoint is empty.
func (s *S3Config) ResolvedEndpoint() string {
	if s.Endpoint != "" {
		return s.Endpoint
	}
	return "https://s3." + s.Region + ".amazonaws.com"
}
