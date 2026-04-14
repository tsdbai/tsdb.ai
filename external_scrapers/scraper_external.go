package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// =============================================================================
// Constants
// =============================================================================

const (
	MaxBufferSizeBytes = 50 * 1024 * 1024 // 50 MB in-memory retry buffer
	MaxScrapeBodyBytes = 10 * 1024 * 1024 // 10 MB max per scrape response (prevent OOM from bad endpoints)
	DefaultJobLabel    = "external"
)

// =============================================================================
// Package-level singletons (initialised once, never re-allocated)
// =============================================================================

// Prometheus text-format line regex — compiled once at startup, not per scrape.
// Captures: (1) metric_name{labels} and (2) numeric value.
// The optional third column (timestamp_ms) is intentionally ignored; we stamp
// samples with the local scrape time, consistent with how Prometheus itself works
// when remote-writing to a downstream system.
var reMetric = regexp.MustCompile(`^([a-zA-Z_:][a-zA-Z0-9_:{}=,"/\.\-\[\]\s]+)\s+([0-9\.eE\+\-]+)`)

// Shared HTTP clients with connection pooling so TCP connections are reused
// across scrape rounds and ingestor flushes.
var (
	scrapeClient = &http.Client{
		// Timeout is set at startup once scrapeTimeout is known.
		Transport: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 10,
			IdleConnTimeout:     90 * time.Second,
		},
	}
	ingestClient = &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:    10,
			IdleConnTimeout: 90 * time.Second,
		},
	}
)

// =============================================================================
// Global state
// =============================================================================

var (
	ingestEndpoint string
	jobLabel       string
)

// Retry buffer — samples accumulate here while the ingestor is unreachable.
var (
	retryBuffer       []MetricSample
	bufferMu          sync.Mutex
	currentBufferSize int
)

// Self-monitoring counters (read with atomic.LoadInt64, written with atomic.AddInt64).
var (
	statScraped   int64
	statSent      int64
	statDropped   int64
	statScrapeErr int64
	statIngestErr int64
)

// =============================================================================
// Data types
// =============================================================================

type MetricSample struct {
	MetricString string  `json:"metric_string"`
	Value        float64 `json:"value"`
	Timestamp    float64 `json:"timestamp"`
}

// =============================================================================
// Label injection
// =============================================================================

// injectLabels stamps instance= and job= onto a Prometheus metric string so
// that samples from different targets remain distinguishable inside the TSDB.
//
// Without this, two hosts both exposing node_cpu_seconds_total{cpu="0",...}
// would produce identical metric strings and silently overwrite each other.
//
// Examples:
//
//	"http_requests_total{method="GET"}"  →  "http_requests_total{instance="h:p",job="j",method="GET"}"
//	"go_gc_duration_seconds"             →  "go_gc_duration_seconds{instance="h:p",job="j"}"
func injectLabels(metricStr, instance, job string) string {
	injected := fmt.Sprintf(`instance="%s",job="%s"`, instance, job)
	if idx := strings.LastIndex(metricStr, "}"); idx != -1 {
		// Strip any trailing comma/space before the closing brace to keep labels clean.
		prefix := strings.TrimRight(metricStr[:idx], ", ")
		return prefix + "," + injected + "}"
	}
	return strings.TrimSpace(metricStr) + "{" + injected + "}"
}

// instanceFromURL derives the "host:port" label value from a target URL.
// If the URL has no explicit port, the scheme default (80/443) is used.
func instanceFromURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return rawURL
	}
	if _, _, err := net.SplitHostPort(u.Host); err != nil {
		switch u.Scheme {
		case "https":
			return u.Host + ":443"
		default:
			return u.Host + ":80"
		}
	}
	return u.Host
}

// =============================================================================
// Prometheus text-format parser
// =============================================================================

func parsePrometheusMetrics(data []byte, instance, job string) []MetricSample {
	lines := strings.Split(string(data), "\n")
	samples := make([]MetricSample, 0, len(lines)/2)
	now := float64(time.Now().UnixNano()) / 1e9

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		m := reMetric.FindStringSubmatch(line)
		if len(m) < 3 {
			continue
		}
		val, err := strconv.ParseFloat(m[2], 64)
		if err != nil {
			continue
		}
		samples = append(samples, MetricSample{
			MetricString: injectLabels(strings.TrimSpace(m[1]), instance, job),
			Value:        val,
			Timestamp:    now,
		})
	}
	return samples
}

// =============================================================================
// Ingestor communication
// =============================================================================

func sendBatch(samples []MetricSample) error {
	data, err := json.Marshal(samples)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", ingestEndpoint, bytes.NewBuffer(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := ingestClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body) // drain so the connection is returned to the pool

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("non-200 status: %d", resp.StatusCode)
	}
	return nil
}

// pushMetricsToIngestor attempts to deliver samples, buffering on failure.
// Network calls are made without holding the buffer lock to avoid stalling
// other goroutines trying to buffer their own results concurrently.
func pushMetricsToIngestor(samples []MetricSample) {
	if len(samples) == 0 {
		return
	}

	// Snapshot the backlog under lock, then release before making network calls.
	bufferMu.Lock()
	var pending []MetricSample
	if len(retryBuffer) > 0 {
		pending = make([]MetricSample, len(retryBuffer))
		copy(pending, retryBuffer)
	}
	bufferMu.Unlock()

	if len(pending) > 0 {
		fmt.Printf("[%s] RECOVERY: flushing %d buffered samples...\n", ts(), len(pending))
		if err := sendBatch(pending); err == nil {
			fmt.Printf("[%s] RECOVERY: buffer flushed.\n", ts())
			bufferMu.Lock()
			retryBuffer = retryBuffer[:0]
			currentBufferSize = 0
			bufferMu.Unlock()
			atomic.AddInt64(&statSent, int64(len(pending)))
		} else {
			fmt.Printf("[%s] RECOVERY FAILED: %v — buffering new samples too.\n", ts(), err)
			atomic.AddInt64(&statIngestErr, 1)
			bufferMu.Lock()
			addToBuffer(samples)
			bufferMu.Unlock()
			return
		}
	}

	if err := sendBatch(samples); err != nil {
		fmt.Printf("[%s] PUSH ERROR: %v — buffering %d samples.\n", ts(), err, len(samples))
		atomic.AddInt64(&statIngestErr, 1)
		bufferMu.Lock()
		addToBuffer(samples)
		bufferMu.Unlock()
	} else {
		atomic.AddInt64(&statSent, int64(len(samples)))
		fmt.Printf("[%s] Pushed %d samples.\n", ts(), len(samples))
	}
}

// addToBuffer appends to the retry buffer. Must be called with bufferMu held.
// Uses actual JSON-serialised length for an accurate cap check (not an estimate).
func addToBuffer(samples []MetricSample) {
	data, _ := json.Marshal(samples)
	sz := len(data)
	if sz == 0 {
		sz = len(samples) * 512 // safe fallback if marshal somehow fails
	}
	if currentBufferSize+sz > MaxBufferSizeBytes {
		fmt.Printf("[%s] CRITICAL: buffer full — dropping %d samples.\n", ts(), len(samples))
		atomic.AddInt64(&statDropped, int64(len(samples)))
		return
	}
	retryBuffer = append(retryBuffer, samples...)
	currentBufferSize += sz
}

// =============================================================================
// Scrape worker
// =============================================================================

func scrapeTarget(ctx context.Context, targetURL string) {
	instance := instanceFromURL(targetURL)
	start := time.Now()

	req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
	if err != nil {
		fmt.Printf("[%s] REQUEST ERROR %s: %v\n", ts(), targetURL, err)
		atomic.AddInt64(&statScrapeErr, 1)
		return
	}
	// Signal we accept the Prometheus 0.0.4 text exposition format.
	req.Header.Set("Accept", "text/plain;version=0.0.4,*/*")

	resp, err := scrapeClient.Do(req)
	if err != nil {
		fmt.Printf("[%s] SCRAPE FAIL %s: %v\n", ts(), targetURL, err)
		atomic.AddInt64(&statScrapeErr, 1)
		return
	}
	defer resp.Body.Close()

	// LimitReader prevents a misbehaving endpoint from causing OOM.
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxScrapeBodyBytes))
	if err != nil {
		fmt.Printf("[%s] READ ERROR %s: %v\n", ts(), targetURL, err)
		atomic.AddInt64(&statScrapeErr, 1)
		return
	}

	samples := parsePrometheusMetrics(body, instance, jobLabel)
	atomic.AddInt64(&statScraped, int64(len(samples)))
	fmt.Printf("[%s] Scraped %s in %v — %d samples\n",
		ts(), targetURL, time.Since(start).Round(time.Millisecond), len(samples))

	pushMetricsToIngestor(samples)
}

// =============================================================================
// Self-monitoring HTTP server
// =============================================================================

func startHealthServer(port int) {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","ingest_endpoint":%q}`, ingestEndpoint)
	})

	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")

		bufferMu.Lock()
		bufLen := len(retryBuffer)
		bufBytes := currentBufferSize
		bufferMu.Unlock()

		type m struct{ name, help, typ string; val int64 }
		for _, metric := range []m{
			{"scraper_samples_scraped_total", "Total samples parsed from all targets", "counter", atomic.LoadInt64(&statScraped)},
			{"scraper_samples_sent_total", "Samples successfully delivered to ingestor", "counter", atomic.LoadInt64(&statSent)},
			{"scraper_samples_dropped_total", "Samples dropped because retry buffer was full", "counter", atomic.LoadInt64(&statDropped)},
			{"scraper_scrape_errors_total", "Scrape attempts that failed", "counter", atomic.LoadInt64(&statScrapeErr)},
			{"scraper_ingest_errors_total", "Ingestor push attempts that failed", "counter", atomic.LoadInt64(&statIngestErr)},
		} {
			fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n%s %d\n\n",
				metric.name, metric.help, metric.name, metric.typ, metric.name, metric.val)
		}
		fmt.Fprintf(w, "# HELP scraper_buffer_samples Samples currently held in the retry buffer\n")
		fmt.Fprintf(w, "# TYPE scraper_buffer_samples gauge\nscraper_buffer_samples %d\n\n", bufLen)
		fmt.Fprintf(w, "# HELP scraper_buffer_bytes Serialised bytes currently held in the retry buffer\n")
		fmt.Fprintf(w, "# TYPE scraper_buffer_bytes gauge\nscraper_buffer_bytes %d\n", bufBytes)
	})

	go http.ListenAndServe(fmt.Sprintf(":%d", port), mux)
	fmt.Printf("[%s] Self-monitoring → http://localhost:%d/health  |  http://localhost:%d/metrics\n", ts(), port, port)
}

// =============================================================================
// Entry point
// =============================================================================

func main() {
	scrapeURLsFlag := flag.String("scrape-urls", "", "Comma-separated Prometheus /metrics endpoints to scrape")
	intervalFlag   := flag.Int("scrape-interval-seconds", 0, "Seconds between scrape rounds (min 15, default 30)")
	timeoutFlag    := flag.Int("scrape-timeout-seconds", 0, "HTTP timeout per individual scrape (default 15)")
	ingestFlag     := flag.String("ingest-endpoint", "", "tsdb.ai ingestor URL, e.g. http://localhost:8080/ingest_samples")
	jobFlag        := flag.String("job-label", "", `Value injected as job= on every sample (default "external")`)
	healthPortFlag := flag.Int("health-port", 0, "Port for /health and /metrics self-monitoring endpoint (0 = disabled)")
	flag.Parse()

	// ── ingest endpoint (env → flag) ─────────────────────────────────────────
	ingestEndpoint = env("INGEST_ENDPOINT", "")
	if *ingestFlag != "" {
		ingestEndpoint = *ingestFlag
	}
	if ingestEndpoint == "" {
		fmt.Fprintln(os.Stderr, "Error: ingest endpoint required (--ingest-endpoint or INGEST_ENDPOINT env var)")
		os.Exit(1)
	}

	// ── job label (env → flag → default) ─────────────────────────────────────
	jobLabel = env("JOB_LABEL", DefaultJobLabel)
	if *jobFlag != "" {
		jobLabel = *jobFlag
	}

	// ── targets (env → flag) ─────────────────────────────────────────────────
	var targets []string
	parseList := func(s string) {
		for _, u := range strings.Split(s, ",") {
			if u = strings.TrimSpace(u); u != "" {
				targets = append(targets, u)
			}
		}
	}
	parseList(env("SCRAPE_URLS", ""))
	if *scrapeURLsFlag != "" {
		parseList(*scrapeURLsFlag)
	}
	if len(targets) == 0 {
		fmt.Fprintln(os.Stderr, "Error: no scrape targets (--scrape-urls or SCRAPE_URLS env var)")
		os.Exit(1)
	}

	// ── interval ─────────────────────────────────────────────────────────────
	interval := envInt("SCRAPE_INTERVAL_SECONDS", 30)
	if *intervalFlag > 0 {
		interval = *intervalFlag
	}
	if interval < 15 {
		fmt.Printf("Warning: interval %ds < 15s minimum; using 15s.\n", interval)
		interval = 15
	}

	// ── timeout ──────────────────────────────────────────────────────────────
	timeout := envInt("SCRAPE_TIMEOUT_SECONDS", 15)
	if *timeoutFlag > 0 {
		timeout = *timeoutFlag
	}
	if timeout >= interval {
		timeout = interval - 1
		fmt.Printf("Warning: timeout must be < interval; capped to %ds.\n", timeout)
	}
	scrapeClient.Timeout = time.Duration(timeout) * time.Second

	// ── health server ─────────────────────────────────────────────────────────
	healthPort := envInt("HEALTH_PORT", 0)
	if *healthPortFlag > 0 {
		healthPort = *healthPortFlag
	}
	if healthPort > 0 {
		startHealthServer(healthPort)
	}

	// ── startup banner ────────────────────────────────────────────────────────
	fmt.Println("--- tsdb.ai External Scraper ---")
	fmt.Printf("Ingestor  : %s\n", ingestEndpoint)
	fmt.Printf("Targets   : %v\n", targets)
	fmt.Printf("Job label : %s\n", jobLabel)
	fmt.Printf("Interval  : %ds  Timeout: %ds\n", interval, timeout)

	// ── graceful shutdown ─────────────────────────────────────────────────────
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Printf("\n[%s] Shutdown signal received — draining in-flight scrapes...\n", ts())
		cancel()
	}()

	// ── scrape loop ───────────────────────────────────────────────────────────
	runRound := func() {
		for _, target := range targets {
			target := target
			wg.Add(1)
			go func() {
				defer wg.Done()
				scrapeTarget(ctx, target)
			}()
		}
	}

	runRound() // immediate first scrape; don't wait for the first tick
	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			runRound()
		case <-ctx.Done():
			wg.Wait() // drain all in-flight goroutines before final flush
			bufferMu.Lock()
			if n := len(retryBuffer); n > 0 {
				fmt.Printf("[%s] Final flush of %d buffered samples...\n", ts(), n)
				if err := sendBatch(retryBuffer); err != nil {
					fmt.Printf("[%s] Final flush failed: %v (%d samples lost)\n", ts(), err, n)
				} else {
					fmt.Printf("[%s] Final flush succeeded.\n", ts())
				}
			}
			bufferMu.Unlock()
			return
		}
	}
}

// =============================================================================
// Helpers
// =============================================================================

func ts() string { return time.Now().Format("15:04:05") }

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
