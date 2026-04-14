package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// NOTE: All tunable constants have moved to tsdb.yaml / config.go as Cfg.Scraper.*

// MaxScrapeBodyBytes caps the body we read from a /metrics endpoint (10 MB).
const MaxScrapeBodyBytes = 10 * 1024 * 1024

// package-level regex — compiled once, reused on every scrape.
var reMetricLine = regexp.MustCompile(`^([a-zA-Z_:][a-zA-Z0-9_:{}=,"/.\-\[\]\s]+)\s+([0-9.eE+\-]+)`)

// shared HTTP clients — one for scraping targets, one for pushing to ingestor.
// scrapeClient is initialised in buildScrapeClient() after config is loaded so
// that an optional proxy URL can be wired in.  ingestClient talks only to the
// local ingestor and never goes through a proxy.
var (
	scrapeClient *http.Client                      // set by buildScrapeClient()
	ingestClient = &http.Client{Timeout: 10 * time.Second}
)

// buildScrapeClient constructs the HTTP client used for all outbound scrape
// requests.  If Cfg.Scraper.ProxyURL is non-empty the client routes through
// that proxy; otherwise it connects directly.
func buildScrapeClient() {
	transport := &http.Transport{
		MaxIdleConns:        50,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
	}

	if Cfg.Scraper.ProxyURL != "" {
		proxyURL, err := url.Parse(Cfg.Scraper.ProxyURL)
		if err != nil {
			Logf("SCRAPER", "WARNING: invalid proxy_url %q — connecting directly: %v",
				Cfg.Scraper.ProxyURL, err)
		} else {
			transport.Proxy = http.ProxyURL(proxyURL)
			Logf("SCRAPER", "proxy enabled: %s", Cfg.Scraper.ProxyURL)
		}
	}

	scrapeClient = &http.Client{
		Transport: transport,
		Timeout:   time.Duration(Cfg.Scraper.TimeoutS) * time.Second,
	}
}

// --- Data Structures ---

type MetricSample struct {
	MetricString string  `json:"metric_string"`
	Value        float64 `json:"value"`
	Timestamp    float64 `json:"timestamp"`
}

// --- Stats ---

var (
	statScrapes  int64 // total scrape cycles completed
	statPushed   int64 // total samples successfully sent
	statDropped  int64 // samples dropped due to full buffer
	statErrors   int64 // send errors (triggers buffering)
)

// --- Resiliency Buffer ---

var (
	retryBuffer       []MetricSample
	bufferMutex       sync.Mutex
	currentBufferSize int
)

// --- Utility Functions ---

func parsePrometheusMetrics(data []byte) []MetricSample {
	lines := strings.Split(string(data), "\n")
	var samples []MetricSample
	currentTime := float64(time.Now().UnixNano()) / 1e9

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		match := reMetricLine.FindStringSubmatch(line)
		if len(match) >= 3 {
			metricString := strings.TrimSpace(match[1])
			value, err := strconv.ParseFloat(match[2], 64)
			if err == nil {
				samples = append(samples, MetricSample{
					MetricString: metricString,
					Value:        value,
					Timestamp:    currentTime,
				})
			}
		}
	}
	return samples
}

// sendBatch marshals samples and POSTs them to the ingestor.
// Returns an error so the caller can decide whether to buffer.
func sendBatch(samples []MetricSample) error {
	data, err := json.Marshal(samples)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", Cfg.Scraper.IngestEndpoint, bytes.NewBuffer(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := ingestClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("non-200 status: %d", resp.StatusCode)
	}
	return nil
}

func pushMetricsToIngestor(samples []MetricSample) {
	if len(samples) == 0 {
		return
	}

	// 1. Try to flush existing buffer first.
	bufferMutex.Lock()
	if len(retryBuffer) > 0 {
		Logf("SCRAPER", "RECOVERY: flushing %d buffered samples…", len(retryBuffer))
		err := sendBatch(retryBuffer)
		if err == nil {
			atomic.AddInt64(&statPushed, int64(len(retryBuffer)))
			Logf("SCRAPER", "RECOVERY OK: buffer flushed to ingestor")
			retryBuffer = []MetricSample{}
			currentBufferSize = 0
		} else {
			Logf("SCRAPER", "RECOVERY FAILED: ingestor still down (%v) — keeping buffer", err)
			addToBuffer(samples)
			bufferMutex.Unlock()
			return
		}
	}
	bufferMutex.Unlock()

	// 2. Send current batch.
	err := sendBatch(samples)
	if err != nil {
		atomic.AddInt64(&statErrors, 1)
		Logf("SCRAPER", "ERROR pushing %d samples: %v — buffering locally", len(samples), err)
		bufferMutex.Lock()
		addToBuffer(samples)
		bufferMutex.Unlock()
	} else {
		atomic.AddInt64(&statPushed, int64(len(samples)))
	}
}

func addToBuffer(samples []MetricSample) {
	// Use accurate JSON size rather than a rough estimate.
	data, _ := json.Marshal(samples)
	estimatedSize := len(data)
	if currentBufferSize+estimatedSize > Cfg.Scraper.MaxBufferBytes {
		atomic.AddInt64(&statDropped, int64(len(samples)))
		Logf("SCRAPER", "CRITICAL: buffer full (%d bytes) — dropping %d samples to prevent OOM",
			currentBufferSize, len(samples))
		return
	}
	retryBuffer = append(retryBuffer, samples...)
	currentBufferSize += estimatedSize
}

func scrapeTarget(targetURL string) {
	start := time.Now()
	// Timeout is already set on scrapeClient.Transport; the context provides an
	// additional per-request cancellation handle (e.g. if the goroutine is
	// asked to stop early in future).
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(Cfg.Scraper.TimeoutS)*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
	if err != nil {
		Logf("SCRAPER", "ERROR building request for %s: %v", targetURL, err)
		return
	}

	resp, err := scrapeClient.Do(req)
	if err != nil {
		Logf("SCRAPER", "SCRAPE FAIL: %s unreachable: %v", targetURL, err)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxScrapeBodyBytes))
	if err != nil {
		Logf("SCRAPER", "ERROR reading body from %s: %v", targetURL, err)
		return
	}

	samples := parsePrometheusMetrics(body)
	elapsed := time.Since(start).Round(time.Millisecond)
	Logf("SCRAPER", "scraped %s → %d samples in %v", targetURL, len(samples), elapsed)

	atomic.AddInt64(&statScrapes, 1)
	pushMetricsToIngestor(samples)
}

// scraperHeartbeat logs rolling statistics every minute.
func scraperHeartbeat() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		bufferMutex.Lock()
		buffered := len(retryBuffer)
		bufBytes := currentBufferSize
		bufferMutex.Unlock()

		Logf("SCRAPER", "stats  scrapes=%d  pushed=%d  errors=%d  dropped=%d  buffer=%d samples (%.1f KB)",
			atomic.LoadInt64(&statScrapes),
			atomic.LoadInt64(&statPushed),
			atomic.LoadInt64(&statErrors),
			atomic.LoadInt64(&statDropped),
			buffered, float64(bufBytes)/1024)
	}
}

func main() {
	LoadConfig("tsdb.yaml")
	buildScrapeClient() // must come after LoadConfig so proxy URL is available
	PrintBanner("Scraper Agent")

	targets := []string{Cfg.Scraper.TargetEndpoint}
	proxyDisplay := "none (direct)"
	if Cfg.Scraper.ProxyURL != "" {
		proxyDisplay = Cfg.Scraper.ProxyURL
	}
	Logf("SCRAPER", "Self-metric scraper — internal targets only")
	Logf("SCRAPER", "  target  : %s", Cfg.Scraper.TargetEndpoint)
	Logf("SCRAPER", "  ingestor: %s", Cfg.Scraper.IngestEndpoint)
	Logf("SCRAPER", "  interval: %ds  timeout: %ds  buffer: %s",
		Cfg.Scraper.IntervalS, Cfg.Scraper.TimeoutS,
		truncate(fmt.Sprintf("%d bytes", Cfg.Scraper.MaxBufferBytes), 20))
	Logf("SCRAPER", "  proxy   : %s", proxyDisplay)

	go scraperHeartbeat()

	ticker := time.NewTicker(time.Duration(Cfg.Scraper.IntervalS) * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		for _, target := range targets {
			go scrapeTarget(target)
		}
	}
}
