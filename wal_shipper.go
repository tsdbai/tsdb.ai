package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)





// NOTE: IndexUpdate struct definition is in model_compressor.go

// ChunkPayload reflects the single chunk file structure from the Ingestor
type ChunkPayload struct {
	MetricString string            `json:"metric_string"`
	ModelID      int               `json:"model_id"`
	Params       []float64         `json:"params"`
	TBase        float64           `json:"t_base"`
	Labels       map[string]string `json:"labels"`
}

// BlockPayload is the final structure sent to the Deduper
type BlockPayload struct {
	BlockID     string         `json:"block_id"`
	StartTime   int64          `json:"start_time"`
	EndTime     int64          `json:"end_time"`
	ChunksCount int            `json:"chunks_count"`
	ReplicaID   string         `json:"replica_id"`
	ChunksData  []ChunkPayload `json:"chunks_data"`
}

// PushPayload is the compressed binary data sent over the network
type PushPayload struct {
	BlockID string
	Payload []byte // Compressed binary block data (Gzip)
}

// uploadJob bundles everything an upload worker needs: the payload to push,
// the WAL files to retire on success, and where to send the index event.
type uploadJob struct {
	payload     PushPayload
	filesToMove []string          // WAL files to move to ShippedDir on success
	indexQueue  chan<- IndexUpdate // notification channel
	s3Key       string
}

// uploadJobQueue is the bounded channel between the shipper and upload workers.
// Capacity 100 keeps memory bounded while absorbing short-term bursty blocks.
var uploadJobQueue chan uploadJob

// =============================================================================
// Feature: Parallel S3 Upload Queue
//
// startUploadWorkers spins up Cfg.Shipper.UploadWorkers goroutines that drain
// uploadJobQueue concurrently.  Each worker:
//   1. Pushes the compressed block to the Deduper (with retry/backoff).
//   2. Moves WAL files to ShippedDir so the ingestor can reclaim space.
//   3. Sends an IndexUpdate so the index stays consistent.
//
// This decouples ingestion/compaction latency from network round-trips.
// =============================================================================

func startUploadWorkers(indexQueue chan<- IndexUpdate) {
	var wg sync.WaitGroup
	for i := 0; i < Cfg.Shipper.UploadWorkers; i++ {
		wg.Add(1)
		workerID := i
		go func() {
			defer wg.Done()
			fmt.Printf("[%s] UPLOAD WORKER %d: started\n", time.Now().Format("15:04:05"), workerID)
			for job := range uploadJobQueue {
				if err := pushBlockToDeduper(job.payload); err != nil {
					fmt.Printf("[%s] WORKER %d: FATAL PUSH ERROR for block %s: %v\n",
						time.Now().Format("15:04:05"), workerID, job.payload.BlockID, err)
					continue // leave WAL files in place for next compaction cycle
				}

				fmt.Printf("[%s] WORKER %d: SUCCESS block %s pushed.\n",
					time.Now().Format("15:04:05"), workerID, job.payload.BlockID)

				// Notify the index
				job.indexQueue <- IndexUpdate{
					S3Key:   job.s3Key,
					Action:  "CREATE",
					Version: time.Now().UnixNano(),
				}

				// Retire WAL files
				for _, filePath := range job.filesToMove {
					fileName := filepath.Base(filePath)
					newPath := filepath.Join(ShippedDir, fileName)
					if err := os.Rename(filePath, newPath); err != nil {
						fmt.Printf("[%s] WORKER %d: WARNING: Failed to move WAL file %s: %v\n",
							time.Now().Format("15:04:05"), workerID, fileName, err)
					}
				}
				fmt.Printf("[%s] WORKER %d: Retired %d WAL files to %s.\n",
					time.Now().Format("15:04:05"), workerID, len(job.filesToMove), ShippedDir)
			}
		}()
	}
	// Note: wg.Wait() is intentionally not called — workers run for the
	// lifetime of the process.  The WaitGroup exists only so we don't lose
	// the reference and can extend later.
	_ = wg
}

// =============================================================================
// Feature: Binary WAL reader
//
// readBinaryWALFile decodes the compact binary .bin batch files written by
// writeBinaryWALBatch in main.go.
//
// Binary layout (little-endian):
//   [4]  magic      uint32  = 0x54534442
//   [4]  count      uint32  number of chunks
//   per chunk:
//     [4]  metricLen  uint32
//     [n]  metric     []byte
//     [1]  modelID    uint8
//     [8]  tBase      float64
//     [24] params     3 × float64
// =============================================================================

func readBinaryWALFile(data []byte) ([]ChunkPayload, error) {
	r := bytes.NewReader(data)

	var magic uint32
	if err := binary.Read(r, binary.LittleEndian, &magic); err != nil {
		return nil, fmt.Errorf("failed to read magic: %w", err)
	}
	if magic != WALMagic {
		return nil, fmt.Errorf("invalid magic: got 0x%08X, want 0x%08X", magic, WALMagic)
	}

	var count uint32
	if err := binary.Read(r, binary.LittleEndian, &count); err != nil {
		return nil, fmt.Errorf("failed to read chunk count: %w", err)
	}

	chunks := make([]ChunkPayload, 0, count)
	for i := uint32(0); i < count; i++ {
		var metricLen uint32
		if err := binary.Read(r, binary.LittleEndian, &metricLen); err != nil {
			return nil, fmt.Errorf("chunk %d: failed to read metric length: %w", i, err)
		}

		metricBytes := make([]byte, metricLen)
		if _, err := r.Read(metricBytes); err != nil {
			return nil, fmt.Errorf("chunk %d: failed to read metric string: %w", i, err)
		}
		metricString := string(metricBytes)

		var modelID uint8
		if err := binary.Read(r, binary.LittleEndian, &modelID); err != nil {
			return nil, fmt.Errorf("chunk %d: failed to read model ID: %w", i, err)
		}

		var tBase float64
		if err := binary.Read(r, binary.LittleEndian, &tBase); err != nil {
			return nil, fmt.Errorf("chunk %d: failed to read tBase: %w", i, err)
		}

		params := make([]float64, 3)
		for p := 0; p < 3; p++ {
			if err := binary.Read(r, binary.LittleEndian, &params[p]); err != nil {
				return nil, fmt.Errorf("chunk %d: failed to read param %d: %w", i, p, err)
			}
		}

		chunks = append(chunks, ChunkPayload{
			MetricString: metricString,
			ModelID:      int(modelID),
			TBase:        tBase,
			Params:       params,
			Labels:       extractLabelsShipper(metricString),
		})
	}
	return chunks, nil
}

// extractLabelsShipper is a local copy of extractLabels from main.go.
// wal_shipper compiles as a separate binary, so it cannot share helpers
// directly — keeping a copy here avoids an import cycle.
func extractLabelsShipper(metricString string) map[string]string {
	start := strings.Index(metricString, "{")
	end := strings.LastIndex(metricString, "}")
	labels := make(map[string]string)
	name := metricString
	if start != -1 && end != -1 && end > start {
		name = metricString[:start]
		labelStr := metricString[start+1 : end]
		for _, pair := range strings.Split(labelStr, ",") {
			pair = strings.TrimSpace(pair)
			eqIdx := strings.Index(pair, "=")
			if eqIdx > 0 {
				k := strings.TrimSpace(pair[:eqIdx])
				v := strings.Trim(strings.TrimSpace(pair[eqIdx+1:]), "\"")
				labels[k] = v
			}
		}
	}
	labels["__name__"] = name
	return labels
}

// --- Utility Functions ---

// calculateContentHash computes the SHA256 hash of the sorted chunk data.
func calculateContentHash(chunksData []ChunkPayload) string {
	data, _ := json.Marshal(chunksData)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// compressAndWriteBlock converts the structured payload into a GZIP compressed binary block.
func compressAndWriteBlock(payload BlockPayload) (PushPayload, error) {
	jsonBlock, err := json.Marshal(payload)
	if err != nil {
		return PushPayload{}, fmt.Errorf("failed to marshal block payload: %w", err)
	}

	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	if _, err := w.Write(jsonBlock); err != nil {
		return PushPayload{}, fmt.Errorf("failed to write to gzip buffer: %w", err)
	}
	if err := w.Close(); err != nil {
		return PushPayload{}, fmt.Errorf("failed to close gzip writer: %w", err)
	}

	compressedData := b.Bytes()

	blockFileName := payload.BlockID + ".gz"
	blockFilePath := filepath.Join(ShippedDir, blockFileName)

	if err := ioutil.WriteFile(blockFilePath, compressedData, 0644); err != nil {
		return PushPayload{}, fmt.Errorf("failed to write compressed file to disk: %w", err)
	}

	fmt.Printf("[%s] COMPRESSED: Wrote %s (Original size: %d bytes, Gzip size: %d bytes)\n",
		time.Now().Format("15:04:05"), blockFileName, len(jsonBlock), len(compressedData))

	return PushPayload{BlockID: payload.BlockID, Payload: compressedData}, nil
}

// pushBlockToDeduper attempts to send the compressed block with exponential backoff.
func pushBlockToDeduper(pushPayload PushPayload) error {
	for attempt := 0; attempt < Cfg.Shipper.MaxRetries; attempt++ {
		if attempt > 0 {
			backoffTime := time.Duration(Cfg.Shipper.InitialBackoffMs) * time.Millisecond * time.Duration(math.Pow(2, float64(attempt-1)))
			fmt.Printf("[%s] Retrying block push (Attempt %d) after %v...\n", time.Now().Format("15:04:05"), attempt, backoffTime)
			time.Sleep(backoffTime)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, "POST", Cfg.Server.DeduperEndpoint, bytes.NewBuffer(pushPayload.Payload))
		if err != nil {
			return fmt.Errorf("failed to create request: %w", err)
		}
		req.Header.Set("Content-Type", "application/gzip")
		req.Header.Set("X-Block-ID", pushPayload.BlockID)

		resp, err := http.DefaultClient.Do(req)
		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			return nil // Success
		}

		if resp != nil {
			resp.Body.Close()
			Logf("SHIPPER", "Push attempt %d failed (status %d)", attempt, resp.StatusCode)
		} else {
			Logf("SHIPPER", "Push attempt %d failed: %v", attempt, err)
		}
	}
	return fmt.Errorf("failed to push block %s after %d retries", pushPayload.BlockID, Cfg.Shipper.MaxRetries)
}

// --- Core Shipper Logic ---

func runShipper(indexQueue chan<- IndexUpdate) {
	os.MkdirAll(WALChunksDir, 0755)
	os.MkdirAll(ShippedDir, 0755)

	Logf("SHIPPER", "WAL dir       : %s", WALChunksDir)
	Logf("SHIPPER", "Deduper       : %s", Cfg.Server.DeduperEndpoint)
	Logf("SHIPPER", "Block window  : %d min  |  upload workers: %d  |  max age: %d min",
		Cfg.Shipper.BlockTimeWindowMin, Cfg.Shipper.UploadWorkers, Cfg.Shipper.MaxBlockAgeMinutes)
	Logf("SHIPPER", "Listening on  0.0.0.0 (push-only, no HTTP port)")

	// Initialise upload queue capacity from config, then start workers
	uploadJobQueue = make(chan uploadJob, Cfg.Shipper.UploadQueueCapacity)
	startUploadWorkers(indexQueue)

	compactionTicker := time.NewTicker(time.Duration(Cfg.Shipper.PollIntervalS) * time.Second)
	defer compactionTicker.Stop()

	cleanupTicker := time.NewTicker(Cfg.Shipper.CleanupInterval())
	defer cleanupTicker.Stop()

	// Initial run
	go shipCompletedBlocks(indexQueue)

	for {
		select {
		case <-compactionTicker.C:
			go shipCompletedBlocks(indexQueue)

		case <-cleanupTicker.C:
			go runBlockCleanup(indexQueue)
		}
	}
}

// runBlockCleanup orchestrates the two retention policies
func runBlockCleanup(indexQueue chan<- IndexUpdate) {
	Logf("SHIPPER", "CLEANUP: scheduled block retention check")

	if _, err := performSpaceCleanup(ShippedDir, Cfg.Shipper.DiskUsageThresholdPct, indexQueue); err != nil {
		Logf("SHIPPER", "CLEANUP ERROR (space): %v", err)
	}

	// DEMO: Use minutes instead of days for visibility
	maxAgeDuration := time.Duration(Cfg.Shipper.MaxBlockAgeMinutes) * time.Minute
	if _, err := performTimeCleanup(ShippedDir, maxAgeDuration, indexQueue); err != nil {
		Logf("SHIPPER", "CLEANUP ERROR (time): %v", err)
	}
}

// shipCompletedBlocks reads both legacy .json WAL chunks and new binary .bin
// batch files, compacts them into a single block, and enqueues the upload job
// for the parallel worker pool.
func shipCompletedBlocks(indexQueue chan<- IndexUpdate) {
	currentTime := time.Now().Unix()
	blockWindowSize := int64(Cfg.Shipper.BlockTimeWindowMin * 60)
	blockWindowStart := currentTime - (currentTime % blockWindowSize)

	files, err := ioutil.ReadDir(WALChunksDir)
	if err != nil {
		Logf("SHIPPER", "ERROR reading WAL directory: %v", err)
		return
	}

	var bundledChunks []ChunkPayload
	var filesToShip []string

	for _, file := range files {
		if file.IsDir() {
			continue
		}

		name := file.Name()
		isBin := strings.HasSuffix(name, ".bin")
		isJSON := strings.HasSuffix(name, ".json")
		if !isBin && !isJSON {
			continue
		}

		// Extract the leading timestamp from the filename.
		// Both formats start with a Unix timestamp followed by '_'.
		parts := strings.SplitN(name, "_", 2)
		if len(parts) < 2 {
			continue
		}
		timestamp, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			continue
		}

		if timestamp >= blockWindowStart {
			continue // belongs to the current (open) window — skip
		}

		filePath := filepath.Join(WALChunksDir, name)
		data, err := ioutil.ReadFile(filePath)
		if err != nil {
			Logf("SHIPPER", "WARNING: failed to read WAL file %s: %v", name, err)
			continue
		}

		if isBin {
			// Feature: Binary WAL format — decode compact binary batch file
			chunks, err := readBinaryWALFile(data)
			if err != nil {
				Logf("SHIPPER", "WARNING: failed to decode binary WAL file %s: %v", name, err)
				continue
			}
			bundledChunks = append(bundledChunks, chunks...)
		} else {
			// Legacy JSON single-chunk file
			var chunk ChunkPayload
			if err := json.Unmarshal(data, &chunk); err != nil {
				Logf("SHIPPER", "WARNING: failed to unmarshal JSON chunk %s: %v", name, err)
				continue
			}
			bundledChunks = append(bundledChunks, chunk)
		}

		filesToShip = append(filesToShip, filePath)
	}

	if len(bundledChunks) == 0 {
		return
	}

	contentHash := calculateContentHash(bundledChunks)
	oldestTimestamp := bundledChunks[0].TBase

	blockID := fmt.Sprintf("%d_%d_%s", int64(oldestTimestamp), blockWindowStart, contentHash[:8])

	payload := BlockPayload{
		BlockID:     blockID,
		StartTime:   int64(oldestTimestamp),
		EndTime:     blockWindowStart,
		ChunksCount: len(bundledChunks),
		ReplicaID:   "NODE_GO_A",
		ChunksData:  bundledChunks,
	}

	pushPayload, err := compressAndWriteBlock(payload)
	if err != nil {
		fmt.Printf("[%s] FATAL COMPRESSION ERROR for block %s: %v\n", time.Now().Format("15:04:05"), blockID, err)
		return
	}

	fmt.Printf("[%s] Enqueuing block %s (%d bytes, %d chunks from %d files) for upload...\n",
		time.Now().Format("15:04:05"), blockID, len(pushPayload.Payload), len(bundledChunks), len(filesToShip))

	// Feature: Parallel S3 upload queue — hand off to worker pool instead of
	// blocking the compaction goroutine on a synchronous HTTP round-trip.
	job := uploadJob{
		payload:     pushPayload,
		filesToMove: filesToShip,
		indexQueue:  indexQueue,
		s3Key:       payload.BlockID + ".gz",
	}

	select {
	case uploadJobQueue <- job:
		// enqueued successfully
	default:
		// Queue full — fall back to inline push so we don't silently drop data
		fmt.Printf("[%s] WARN: upload queue full, pushing block %s inline\n",
			time.Now().Format("15:04:05"), blockID)
		if err := pushBlockToDeduper(pushPayload); err != nil {
			fmt.Printf("[%s] FATAL inline push error for block %s: %v\n",
				time.Now().Format("15:04:05"), blockID, err)
			return
		}
		indexQueue <- IndexUpdate{
			S3Key:   job.s3Key,
			Action:  "CREATE",
			Version: time.Now().UnixNano(),
		}
		for _, fp := range filesToShip {
			fn := filepath.Base(fp)
			_ = os.Rename(fp, filepath.Join(ShippedDir, fn))
		}
	}
}

func main() {
	LoadConfig("tsdb.yaml")
	PrintBanner("WAL Shipper")
	indexQueue := make(chan IndexUpdate, 10)
	runShipper(indexQueue)
}
