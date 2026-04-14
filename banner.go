package main

// banner.go — shared startup presentation, logging helpers, and config summary.
//
// Every binary in the tsdb.ai suite includes this file at compile time so all
// services share the same visual identity, consistent log format, and config
// summary logic.  No external dependencies.

import (
	"fmt"
	"strings"
	"time"
)

// =============================================================================
// ASCII art
// =============================================================================

const tsdbBanner = `
  ████████╗███████╗██████╗ ██████╗      █████╗ ██╗
     ██╔══╝██╔════╝██╔══██╗██╔══██╗   ██╔══██╗██║
     ██║   ███████╗██║  ██║██████╔╝   ███████║██║
     ██║   ╚════██║██║  ██║██╔══██╗   ██╔══██║██║
     ██║   ███████║██████╔╝██████╔╝ · ██║  ██║██║
     ╚═╝   ╚══════╝╚═════╝ ╚═════╝   ╚═╝  ╚═╝╚═╝
`

const aiEngineBanner = `
    _      ___     ___   _  _  ___  ___ _  _  ___
   /_\    |_ _|   | __|| \| |/ __||_ _|| \| || __|
  / _ \    | |    | _| | .'|| (_ || | || .'|| _|
 /_/ \_\  |___|   |___|_|\_| \___||___|_|\_||___|

  ___  _____  ___  ___  _____  _  _  ___
 / __|_   _|/ _ \| _ \_   _|| \| |/ __|
 \__ \ | | | |_| |   / | |  | .'|| (_ |
 |___/ |_|  \___/|_|_\ |_|  |_|\_| \___|
`

// =============================================================================
// PrintBanner
// =============================================================================

// PrintBanner prints the shared ASCII art header, website, and service identity.
// Call immediately after LoadConfig() in each service's main().
//
//	PrintBanner("Ingestor")
func PrintBanner(service string) {
	fmt.Println(tsdbBanner)
	fmt.Println("  High-Efficiency Time-Series Database Engine")
	fmt.Println("  https://tsdb.ai")
	fmt.Println()
	fmt.Println(aiEngineBanner)
	fmt.Printf("  ┌─────────────────────────────────────────────────────┐\n")
	fmt.Printf("  │  Service   : %-38s│\n", service)
	fmt.Printf("  │  Data root : %-38s│\n", truncate(DataRoot, 38))
	fmt.Printf("  │  Started   : %-38s│\n", time.Now().Format("2006-01-02 15:04:05 MST"))
	fmt.Printf("  └─────────────────────────────────────────────────────┘\n")
	fmt.Println()
	printConfigSummary()
}

// =============================================================================
// Config summary  (printed as part of PrintBanner)
// =============================================================================

func printConfigSummary() {
	sep := "  " + strings.Repeat("─", 56)
	fmt.Println(sep)
	Logf("CONFIG", "Loaded tsdb.yaml  (data root: %s)", DataRoot)
	fmt.Println(sep)

	// Ports
	Logf("CONFIG", "  Ports        ingest:%-5d  query:%-5d  deduper:%-5d",
		Cfg.Server.IngestPort, Cfg.Server.QueryPort, Cfg.Server.DeduperPort)
	Logf("CONFIG", "               vector:%-5d  exporter:%-5d",
		Cfg.Server.VectorPort, Cfg.Server.ExporterPort)

	// Ingestion
	Logf("CONFIG", "  Ingestion    shards:%-4d  WAL-batch:%-6d  samples/seg:%d",
		Cfg.Ingestion.NumShards, Cfg.Ingestion.WALBatchSize, Cfg.Ingestion.SamplesPerSegment)

	// Shipper
	Logf("CONFIG", "  Shipper      block-window:%dmin  workers:%d  max-age:%dmin",
		Cfg.Shipper.BlockTimeWindowMin, Cfg.Shipper.UploadWorkers, Cfg.Shipper.MaxBlockAgeMinutes)

	// S3
	if Cfg.S3.Enabled {
		retDays := Cfg.S3.RetentionAfterUploadMin / 1440
		Logf("CONFIG", "  S3 LTS       enabled  bucket:%-20s  region:%s",
			Cfg.S3.Bucket, Cfg.S3.Region)
		Logf("CONFIG", "               endpoint:%-30s  local-retention:%dd",
			func() string {
				if Cfg.S3.Endpoint != "" {
					return Cfg.S3.Endpoint
				}
				return "(aws default)"
			}(), retDays)
	} else {
		Logf("CONFIG", "  S3 LTS       disabled  (set s3.enabled: true in tsdb.yaml)")
	}

	fmt.Println(sep)
	fmt.Println()
}

// =============================================================================
// Logf — consistent timestamped log helper
// =============================================================================

// Logf formats and prints a log line with a timestamp and component tag.
//
//	Logf("INGESTOR", "processed %d samples in %v", n, dur)
//	→  [15:04:05] [INGESTOR] processed 42 samples in 3.2ms
func Logf(component, format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Printf("[%s] [%-12s] %s\n", time.Now().Format("15:04:05"), component, msg)
}

// =============================================================================
// Utility
// =============================================================================

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-(n-1):]
}
