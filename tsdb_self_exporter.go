package main

// tsdb_self_exporter.go — Prometheus-compatible metrics exporter for tsdb.ai.
//
// Self-metric feedback loop
// ─────────────────────────
//   ┌──────────────────────────────────────────────────────────────┐
//   │  tsdb_ingestor  ──/internal/metrics──▶  self_exporter        │
//   │      ▲                                  :ExporterPort/metrics│
//   │      │                                        │              │
//   │      └──────────  scraper_agent  ◀────────────┘              │
//   └──────────────────────────────────────────────────────────────┘
//
// The self-exporter bridges two formats:
//   • Internal JSON  (/internal/metrics on the ingestor)
//   • Prometheus text exposition (/metrics on this service)
//
// scraper_agent scrapes this service's /metrics endpoint and pushes the
// results back into the ingestor as regular time-series, so tsdb.ai stores
// its own operational history — viewable through the Query Gateway and
// Grafana just like any other metric.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	MetricsPath = "/metrics"
	HealthPath  = "/health"
)

// IngestorMetrics mirrors the JSON returned by /internal/metrics on the ingestor.
type IngestorMetrics struct {
	TotalSamplesIngested    int     `json:"total_samples_ingested"`
	TotalChunksModeled      int     `json:"total_chunks_modeled"`
	HeadCacheSize           int     `json:"head_cache_size"`
	LastCompactionLatencyMs float64 `json:"last_compaction_latency_ms"`
	AvgRmse                 float64 `json:"avg_rmse"`
	IndexQueueSize          int     `json:"index_queue_size"`
	LTSIndexSizeEntries     int     `json:"lts_index_size_entries"`
	DiskUsagePercent        float64 `json:"disk_usage_percent"`
	TotalShippedBytes       float64 `json:"total_shipped_bytes"`
	TotalCanonicalBytes     float64 `json:"total_canonical_bytes"`
	HeadCacheMemoryBytes    float64 `json:"head_cache_memory_bytes"`
	UniqueSeriesActive      int     `json:"unique_series_active"`
}

// scrapeCount and last fetch time for the tick log
var (
	exporterScrapes   int
	lastFetchedSeries int
)

func fetchIngestorMetrics() (IngestorMetrics, error) {
	endpoint := fmt.Sprintf("http://localhost:%d/internal/metrics", Cfg.Server.IngestPort)
	resp, err := http.Get(endpoint)
	if err != nil {
		return IngestorMetrics{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return IngestorMetrics{}, fmt.Errorf("ingestor returned status %d", resp.StatusCode)
	}

	var m IngestorMetrics
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return IngestorMetrics{}, fmt.Errorf("decode error: %v", err)
	}
	return m, nil
}

func generatePrometheusMetrics(w http.ResponseWriter) {
	m, err := fetchIngestorMetrics()
	if err != nil {
		Logf("EXPORTER", "WARNING: could not reach ingestor: %v", err)
	}
	exporterScrapes++

	out := new(strings.Builder)
	write := func(name, help, typ string, val interface{}) {
		fmt.Fprintf(out, "# HELP %s %s\n# TYPE %s %s\n%s %v\n\n", name, help, name, typ, name, val)
	}

	// ── Ingestion ──────────────────────────────────────────────────────────
	write("tsdb_ingest_samples_total",
		"Total number of samples ingested.", "counter", m.TotalSamplesIngested)
	write("tsdb_chunks_modeled_total",
		"Total model chunks successfully created.", "counter", m.TotalChunksModeled)
	write("tsdb_active_unique_series",
		"Unique series currently active in ingestion buffers.", "gauge", m.UniqueSeriesActive)
	write("tsdb_head_cache_series",
		"Unique series in the in-memory Head Cache.", "gauge", m.HeadCacheSize)
	write("tsdb_avg_reconstruction_error_rmse",
		"Average model reconstruction error (RMSE).", "gauge",
		fmt.Sprintf("%f", m.AvgRmse))

	// ── Storage ────────────────────────────────────────────────────────────
	write("tsdb_head_cache_memory_bytes",
		"Memory allocated for the in-memory Head Cache.", "gauge",
		fmt.Sprintf("%f", m.HeadCacheMemoryBytes))
	write("tsdb_total_shipped_blocks_bytes",
		"Bytes of compressed blocks written to local staging storage.", "gauge",
		fmt.Sprintf("%f", m.TotalShippedBytes))
	write("tsdb_canonical_storage_bytes",
		"Bytes in canonical (deduped / S3-uploaded) long-term storage.", "gauge",
		fmt.Sprintf("%f", m.TotalCanonicalBytes))

	// ── Operational health ─────────────────────────────────────────────────
	write("tsdb_index_queue_size",
		"Depth of the internal synchronisation queue.", "gauge", m.IndexQueueSize)
	write("tsdb_index_entries_total",
		"Total entries in the LTS persistence index.", "counter", m.LTSIndexSizeEntries)
	write("tsdb_last_compaction_latency_ms",
		"Latency of the last major compaction run (ms).", "gauge",
		fmt.Sprintf("%f", m.LastCompactionLatencyMs))
	write("tsdb_local_disk_usage_percent",
		"Local disk usage percentage for WAL and index storage.", "gauge",
		fmt.Sprintf("%f", m.DiskUsagePercent))

	lastFetchedSeries = m.UniqueSeriesActive

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(out.String()))
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"status":"ok","exporter_port":%d,"ingest_port":%d}`,
		Cfg.Server.ExporterPort, Cfg.Server.IngestPort)
}

// exporterTick periodically logs a one-liner so operators can see the exporter
// is alive and what values it last observed.
func exporterTick() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		Logf("EXPORTER", "tick #%d — last series count: %d  scrape endpoint: :%d%s",
			exporterScrapes, lastFetchedSeries, Cfg.Server.ExporterPort, MetricsPath)
	}
}

func main() {
	LoadConfig("tsdb.yaml")
	PrintBanner("Self Exporter")

	Logf("EXPORTER", "Self-metric feedback loop:")
	Logf("EXPORTER", "  ingestor :%d/internal/metrics  →  this service :%d/metrics",
		Cfg.Server.IngestPort, Cfg.Server.ExporterPort)
	Logf("EXPORTER", "  scraper_agent scrapes :%d/metrics and pushes back into ingestor",
		Cfg.Server.ExporterPort)
	Logf("EXPORTER", "  result: tsdb.ai stores its own operational history as time-series")
	Logf("EXPORTER", "Listening on 0.0.0.0:%d", Cfg.Server.ExporterPort)

	http.HandleFunc(MetricsPath, func(w http.ResponseWriter, r *http.Request) {
		generatePrometheusMetrics(w)
	})
	http.HandleFunc(HealthPath, handleHealth)

	go exporterTick()

	if err := http.ListenAndServe(fmt.Sprintf("0.0.0.0:%d", Cfg.Server.ExporterPort), nil); err != nil {
		Logf("EXPORTER", "FATAL: %v", err)
	}
}
