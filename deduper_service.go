package main

import (
	"compress/gzip" 
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"crypto/sha256"
	"encoding/hex"
)

// IngestPath is the HTTP route for block ingestion (not user-configurable).
const IngestPath = "/ingest_block"

// s3UploadQueue is a buffered channel of canonical block file paths that need
// to be uploaded to S3.  Initialised in runDeduperService() after config loads.
var s3UploadQueue chan string

// --- Data Structures ---

type BlockPayload struct {
	BlockID      string         `json:"block_id"`
	StartTime    int64          `json:"start_time"`
	EndTime      int64          `json:"end_time"`
	ChunksCount  int            `json:"chunks_count"`
	ReplicaID    string         `json:"replica_id"` 
	ChunksData   interface{}    `json:"chunks_data"` 
}

type CanonicalEntry struct {
	BlockID string
	BlockHash string
	ReceivedReplicas map[string]bool 
}

var canonicalStore = struct {
	sync.RWMutex
	store map[string]CanonicalEntry 
}{
	store: make(map[string]CanonicalEntry),
}

// --- Utility Functions ---

func calculateContentHash(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func writeCanonicalBlock(payload BlockPayload, blockHash string) error {
	fullData := map[string]interface{}{
		"start_time":         payload.StartTime,
		"end_time":           payload.EndTime,
		"chunks_count":       payload.ChunksCount,
		"data_hash":          blockHash,
		"written_by_replica": payload.ReplicaID,
		"chunks_data":        payload.ChunksData,
	}

	blockFileName := payload.BlockID + ".json"
	blockPath := filepath.Join(CanonicalBlocksDir, blockFileName)

	file, err := os.Create(blockPath)
	if err != nil {
		return fmt.Errorf("failed to create canonical file: %w", err)
	}
	defer file.Close()

	if err := json.NewEncoder(file).Encode(fullData); err != nil {
		return fmt.Errorf("failed to write JSON to file: %w", err)
	}

	Logf("DEDUPER", "CANONICAL: Wrote block %s", blockFileName)

	// Enqueue for async S3 upload if enabled.
	if Cfg.S3.Enabled && s3UploadQueue != nil {
		select {
		case s3UploadQueue <- blockPath:
		default:
			Logf("DEDUPER", "S3 WARNING: upload queue full — block %s not queued immediately", blockFileName)
		}
	}
	return nil
}

// startS3Uploader launches Cfg.S3.UploadWorkers goroutines that drain
// s3UploadQueue, uploading each canonical block to S3 and recording the
// result in the manifest.
func startS3Uploader() {
	if !Cfg.S3.Enabled {
		return
	}

	client, err := NewS3Client()
	if err != nil {
		Logf("DEDUPER", "S3 ERROR: cannot start uploader: %v", err)
		return
	}

	s3UploadQueue = make(chan string, Cfg.S3.UploadQueueCapacity)
	loadS3Manifest()

	for i := 0; i < Cfg.S3.UploadWorkers; i++ {
		go func(workerID int) {
			for blockPath := range s3UploadQueue {
				basename := filepath.Base(blockPath)

				// Skip if already uploaded (e.g. deduper restart re-scans dir)
				if IsUploaded(basename) {
					continue
				}

				data, err := ioutil.ReadFile(blockPath)
				if err != nil {
					Logf("DEDUPER", "S3 worker-%d ERROR reading %s: %v", workerID, basename, err)
					continue
				}

				s3Key := client.FullKey(basename)
				if err := client.PutObject(s3Key, data); err != nil {
					Logf("DEDUPER", "S3 worker-%d ERROR uploading %s: %v", workerID, basename, err)
					// Re-enqueue for retry (best-effort; drop if queue full)
					select {
					case s3UploadQueue <- blockPath:
					default:
					}
					continue
				}

				RecordUpload(basename, s3Key, int64(len(data)))
				Logf("DEDUPER", "S3 worker-%d uploaded %s (%d bytes) → %s", workerID, basename, len(data), s3Key)
			}
		}(i)
	}
	Logf("DEDUPER", "S3 upload workers started (%d workers, queue cap %d)",
		Cfg.S3.UploadWorkers, Cfg.S3.UploadQueueCapacity)
}

// --- HTTP Handler ---

func handleIngestBlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	
	var bodyData []byte
	var err error

	if r.Header.Get("Content-Type") == "application/gzip" {
		gzipReader, err := gzip.NewReader(r.Body)
		if err != nil {
			http.Error(w, "Failed to create gzip reader", http.StatusBadRequest)
			return
		}
		defer gzipReader.Close()
		bodyData, err = ioutil.ReadAll(gzipReader)
	} else {
		bodyData, err = ioutil.ReadAll(r.Body)
	}

	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}
	
	var blockPayload BlockPayload
	if err := json.Unmarshal(bodyData, &blockPayload); err != nil {
		http.Error(w, "Invalid block payload format (Expected JSON)", http.StatusBadRequest)
		Logf("DEDUPER", "ERROR parsing JSON: %v", err)
		return
	}
	
	chunksDataBytes, _ := json.Marshal(blockPayload.ChunksData)
	dataHash := calculateContentHash(chunksDataBytes)
	
	canonicalStore.Lock()
	defer canonicalStore.Unlock()
	
	blockID := blockPayload.BlockID
	replicaID := blockPayload.ReplicaID
	
	if entry, exists := canonicalStore.store[blockID]; exists {
		entry.ReceivedReplicas[replicaID] = true
		canonicalStore.store[blockID] = entry
		
		if dataHash == entry.BlockHash {
			w.WriteHeader(http.StatusOK)
			fmt.Fprintf(w, "HA DUPLICATE: Block %s matched canonical hash.", blockID)
			Logf("DEDUPER", "HA DUPLICATE %s: matched hash from %s", blockID, replicaID)
		} else {
			w.WriteHeader(http.StatusConflict)
			fmt.Fprintf(w, "ERROR CONSISTENCY: Block %s hash mismatch.", blockID)
			Logf("DEDUPER", "ERROR CONSISTENCY %s: hash mismatch from %s", blockID, replicaID)
		}
		
	} else {
		canonicalStore.store[blockID] = CanonicalEntry{
			BlockID: blockID,
			BlockHash: dataHash,
			ReceivedReplicas: map[string]bool{replicaID: true},
		}
		
		if err := writeCanonicalBlock(blockPayload, dataHash); err != nil {
			http.Error(w, fmt.Sprintf("Failed S3 write: %v", err), http.StatusInternalServerError)
			return
		}
		
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, "NEW BLOCK: Block %s stored as canonical.", blockID)
		Logf("DEDUPER", "NEW BLOCK %s: stored canonical version from %s", blockID, replicaID)
	}
}

func runRetentionPolicy() {
	Logf("DEDUPER", "RETENTION: starting  age-limit=%dmin  S3-eviction=%v",
		Cfg.Deduper.MaxCanonicalAgeMinutes, Cfg.S3.Enabled)
	ticker := time.NewTicker(Cfg.Deduper.RetentionCheckInterval())
	defer ticker.Stop()
	for range ticker.C {
		runRetentionCycle()
	}
}

func runRetentionCycle() {
	deletedAge := 0
	deletedS3  := 0

	files, err := ioutil.ReadDir(CanonicalBlocksDir)
	if err != nil {
		return
	}

	// --- Pass 1: age-based deletion (blocks older than MaxCanonicalAgeMinutes) ---
	cutoffTime := time.Now().Add(-time.Duration(Cfg.Deduper.MaxCanonicalAgeMinutes) * time.Minute).Unix()
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		parts := strings.Split(file.Name(), "_")
		if len(parts) < 2 {
			continue
		}
		ts, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			continue
		}
		if ts < cutoffTime {
			path := filepath.Join(CanonicalBlocksDir, file.Name())
			if err := os.Remove(path); err == nil {
				RecordEviction(file.Name()) // mark in manifest if present
				deletedAge++
			}
		}
	}

	// --- Pass 2: S3 retention-window eviction ---
	// Evict local copies of blocks that have been uploaded to S3 and whose
	// local retention window (RetentionAfterUploadMin) has expired.
	if Cfg.S3.Enabled && Cfg.S3.RetentionAfterUploadMin > 0 {
		eligible := BlocksEligibleForEviction()
		for _, entry := range eligible {
			localPath := filepath.Join(CanonicalBlocksDir, entry.LocalFile)
			if err := os.Remove(localPath); err != nil {
				if !os.IsNotExist(err) {
					Logf("DEDUPER", "RETENTION WARNING: could not evict %s: %v", entry.LocalFile, err)
					continue
				}
			}
			RecordEviction(entry.LocalFile)
			deletedS3++
		}
	}

	if deletedAge > 0 || deletedS3 > 0 {
		Logf("DEDUPER", "RETENTION: pruned %d age-expired + %d S3-evicted local blocks", deletedAge, deletedS3)
	}
}

// deduperHeartbeat logs the canonical block count and storage size every 5 min.
func deduperHeartbeat() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		entries, err := os.ReadDir(CanonicalBlocksDir)
		if err != nil {
			continue
		}
		var totalBytes int64
		blockCount := 0
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			if info, err := e.Info(); err == nil {
				totalBytes += info.Size()
				blockCount++
			}
		}
		s3queue := 0
		if s3UploadQueue != nil {
			s3queue = len(s3UploadQueue)
		}
		Logf("DEDUPER", "Canonical blocks: %d  (%.2f MB)  S3 upload queue: %d",
			blockCount, float64(totalBytes)/(1024*1024), s3queue)
	}
}

func runDeduperService() {
	os.MkdirAll(CanonicalBlocksDir, 0755)

	if Cfg.S3.Enabled {
		Logf("DEDUPER", "S3 LTS enabled  bucket=%s  prefix=%s  workers=%d  retention=%dd",
			Cfg.S3.Bucket, Cfg.S3.Prefix, Cfg.S3.UploadWorkers,
			Cfg.S3.RetentionAfterUploadMin/1440)
		startS3Uploader()
	} else {
		Logf("DEDUPER", "S3 LTS disabled  (set s3.enabled: true in tsdb.yaml to activate)")
	}
	Logf("DEDUPER", "Canonical storage: %s", CanonicalBlocksDir)
	Logf("DEDUPER", "Listening on 0.0.0.0:%d", Cfg.Server.DeduperPort)

	http.HandleFunc(IngestPath, handleIngestBlock)
	go runRetentionPolicy()
	go deduperHeartbeat()

	if err := http.ListenAndServe(fmt.Sprintf(":%d", Cfg.Server.DeduperPort), nil); err != nil {
		Logf("DEDUPER", "FATAL: %v", err)
	}
}

func main() {
	LoadConfig("tsdb.yaml")
	PrintBanner("Deduper")
	runDeduperService()
}
