package main

import (
	"fmt"
	"math"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"
)

// NOTE: DataSourcePort has moved to tsdb.yaml / config.go as Cfg.Server.MockSourcePort.
const MetricsPath = "/metrics"

// Global state for cumulative counters
var counterState = make(map[string]int)
var mutex = sync.RWMutex{}

// Pre-generate stable, high-cardinality paths
const numHighCardinalitySeries = 30
var stablePaths = make([]string, numHighCardinalitySeries)
var stableStatuses = []string{"200", "404", "500"}

func init() {
	// Seed random generator for predictable variability
	rand.Seed(time.Now().UnixNano()) 
	for i := 0; i < numHighCardinalitySeries; i++ {
		stablePaths[i] = fmt.Sprintf("/api/v2/users/%d", rand.Intn(900000)+100000)
	}
}

// generateMetrics produces Prometheus exposition format data.
func generateMetrics(w http.ResponseWriter) {
	currentTimestampMs := time.Now().UnixNano() / int64(time.Millisecond)
	output := new(strings.Builder)

	// 1. Gauges (Volatile Metrics)
	cpuUsage := math.Abs(rand.NormFloat64()*15 + 50) // ~50 +/- 15
	memUsagePercent := math.Abs(rand.NormFloat64()*5 + 65)
	queueDepth := 50.0 + 25.0*(math.Sin(float64(time.Now().Unix())/600.0)+rand.Float64()*0.2-0.1)
	memFreeKB := memUsagePercent * 1024 // Scale to KB (65000 range)

	fmt.Fprintf(output, "# HELP mock_cpu_utilization_percent Current CPU utilization in percent.\n")
	fmt.Fprintf(output, "# TYPE mock_cpu_utilization_percent gauge\n")
	fmt.Fprintf(output, "mock_cpu_utilization_percent{instance=\"web-01\", core=\"cpu0\"} %.2f %d\n", cpuUsage, currentTimestampMs)
	fmt.Fprintf(output, "mock_memory_free_bytes{instance=\"web-01\", zone=\"us-west-1\"} %.0f %d\n", memFreeKB, currentTimestampMs)
	fmt.Fprintf(output, "mock_queue_depth_items{shard=\"main\", type=\"processor\"} %.2f %d\n", queueDepth, currentTimestampMs)

	// 2. Counters (Cumulative Metrics)
	fmt.Fprintf(output, "# HELP mock_http_requests_total Total number of HTTP requests.\n")
	fmt.Fprintf(output, "# TYPE mock_http_requests_total counter\n")

	mutex.Lock()
	for _, status := range stableStatuses {
		for _, pathID := range stablePaths {
			seriesKey := fmt.Sprintf("%s_%s", status, pathID)
			
			// Increment counter state (starting from 0)
			currentValue := counterState[seriesKey] + rand.Intn(5) + 1 
			counterState[seriesKey] = currentValue
			
			fmt.Fprintf(output, "mock_http_requests_total{job=\"api\", method=\"GET\", status=\"%s\", path=\"%s\"} %d %d\n", status, pathID, currentValue, currentTimestampMs)
		}
	}
	mutex.Unlock()

	w.WriteHeader(http.StatusOK)
	w.Write([]byte(output.String()))
}

func main() {
	LoadConfig("tsdb.yaml")
	fmt.Println("--- Mock Data Source (Go Exporter) ---")
	fmt.Printf("Exposing Prometheus metrics on :%d\n", Cfg.Server.MockSourcePort)

	http.HandleFunc(MetricsPath, func(w http.ResponseWriter, r *http.Request) {
		generateMetrics(w)
	})

	if err := http.ListenAndServe(fmt.Sprintf(":%d", Cfg.Server.MockSourcePort), nil); err != nil {
		fmt.Printf("ERROR: Failed to start data source server: %v\n", err)
	}
}