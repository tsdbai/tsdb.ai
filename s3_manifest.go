package main

// =============================================================================
// S3 Upload Manifest
//
// The manifest is a lightweight JSON file at tsdb.ai-data/index/s3_manifest.json
// that tracks the upload state of every canonical block.  It answers two
// questions at query time:
//
//   "Has this block been uploaded to S3?"   → use S3Key to fetch
//   "Is the local copy still here?"         → Evicted flag
//
// The deduper writes manifest entries after each successful upload.
// The retention checker marks entries Evicted=true after the local copy
// is deleted.
// The query gateway reads the manifest to find S3 keys for cache misses.
// =============================================================================

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"os"
	"sync"
	"time"
)

// S3BlockEntry records the upload state of a single canonical block.
type S3BlockEntry struct {
	// LocalFile is the basename of the canonical block (e.g. "1717200000_…json").
	LocalFile string `json:"local_file"`

	// S3Key is the full object key inside the bucket (includes prefix).
	S3Key string `json:"s3_key"`

	// UploadedAt is the Unix epoch when the S3 upload was confirmed.
	UploadedAt int64 `json:"uploaded_at"`

	// SizeBytes is the byte size of the object on S3.
	SizeBytes int64 `json:"size_bytes"`

	// Evicted is true once the local copy has been deleted by the retention checker.
	// After eviction all LTS queries for this block go to S3.
	Evicted bool `json:"evicted"`

	// EvictedAt is the Unix epoch when the local file was deleted.
	// Zero if the file has not been evicted yet.
	EvictedAt int64 `json:"evicted_at,omitempty"`
}

// s3Manifest is the in-process, thread-safe manifest.
// Keyed by LocalFile (basename).
type s3Manifest struct {
	mu      sync.RWMutex
	Entries map[string]*S3BlockEntry `json:"entries"`
}

// globalS3Manifest is the process-wide manifest singleton.
var globalS3Manifest = &s3Manifest{
	Entries: make(map[string]*S3BlockEntry),
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// loadS3Manifest reads the manifest from disk into globalS3Manifest.
// A missing file is not an error — it just means no blocks have been uploaded yet.
func loadS3Manifest() {
	data, err := ioutil.ReadFile(S3ManifestFile)
	if err != nil {
		if !os.IsNotExist(err) {
			fmt.Printf("[S3MANIFEST] WARNING: could not read manifest: %v\n", err)
		}
		return
	}
	globalS3Manifest.mu.Lock()
	defer globalS3Manifest.mu.Unlock()
	if err := json.Unmarshal(data, globalS3Manifest); err != nil {
		fmt.Printf("[S3MANIFEST] WARNING: could not parse manifest: %v — starting fresh\n", err)
		globalS3Manifest.Entries = make(map[string]*S3BlockEntry)
		return
	}
	fmt.Printf("[S3MANIFEST] Loaded %d block entries.\n", len(globalS3Manifest.Entries))
}

// saveS3Manifest writes globalS3Manifest to disk atomically.
// Called after every mutation (upload recorded, eviction recorded).
func saveS3Manifest() {
	globalS3Manifest.mu.RLock()
	data, err := json.MarshalIndent(globalS3Manifest, "", "  ")
	globalS3Manifest.mu.RUnlock()
	if err != nil {
		fmt.Printf("[S3MANIFEST] ERROR: marshal failed: %v\n", err)
		return
	}
	// Atomic write: write to a temp file then rename
	tmpPath := S3ManifestFile + ".tmp"
	if err := ioutil.WriteFile(tmpPath, data, 0644); err != nil {
		fmt.Printf("[S3MANIFEST] ERROR: write failed: %v\n", err)
		return
	}
	if err := os.Rename(tmpPath, S3ManifestFile); err != nil {
		fmt.Printf("[S3MANIFEST] ERROR: rename failed: %v\n", err)
	}
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

// RecordUpload stores a successful upload in the manifest and persists it.
func RecordUpload(localFile, s3Key string, sizeBytes int64) {
	globalS3Manifest.mu.Lock()
	globalS3Manifest.Entries[localFile] = &S3BlockEntry{
		LocalFile:  localFile,
		S3Key:      s3Key,
		UploadedAt: time.Now().Unix(),
		SizeBytes:  sizeBytes,
		Evicted:    false,
	}
	globalS3Manifest.mu.Unlock()
	go saveS3Manifest()
}

// RecordEviction marks a block's local copy as deleted.
func RecordEviction(localFile string) {
	globalS3Manifest.mu.Lock()
	if entry, ok := globalS3Manifest.Entries[localFile]; ok {
		entry.Evicted    = true
		entry.EvictedAt  = time.Now().Unix()
	}
	globalS3Manifest.mu.Unlock()
	go saveS3Manifest()
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// GetEntry returns the manifest entry for localFile, or nil if not present.
func GetEntry(localFile string) *S3BlockEntry {
	globalS3Manifest.mu.RLock()
	defer globalS3Manifest.mu.RUnlock()
	if entry, ok := globalS3Manifest.Entries[localFile]; ok {
		copy := *entry
		return &copy
	}
	return nil
}

// BlocksEligibleForEviction returns entries that have been uploaded to S3 and
// whose local retention window has expired but whose local copy has not yet
// been evicted.  The caller (retention checker) deletes the files and calls
// RecordEviction for each one.
func BlocksEligibleForEviction() []*S3BlockEntry {
	if Cfg.S3.RetentionAfterUploadMin == 0 {
		return nil // 0 = keep local copies forever
	}
	cutoff := time.Now().Unix() - int64(Cfg.S3.RetentionAfterUpload().Seconds())

	globalS3Manifest.mu.RLock()
	defer globalS3Manifest.mu.RUnlock()

	var eligible []*S3BlockEntry
	for _, entry := range globalS3Manifest.Entries {
		if !entry.Evicted && entry.UploadedAt > 0 && entry.UploadedAt < cutoff {
			copy := *entry
			eligible = append(eligible, &copy)
		}
	}
	return eligible
}

// S3OnlyBlocks returns entries that are on S3 but no longer local.
// Used by query_gateway to build the S3-aware block catalog.
func S3OnlyBlocks() []*S3BlockEntry {
	globalS3Manifest.mu.RLock()
	defer globalS3Manifest.mu.RUnlock()

	var blocks []*S3BlockEntry
	for _, entry := range globalS3Manifest.Entries {
		if entry.Evicted && entry.S3Key != "" {
			copy := *entry
			blocks = append(blocks, &copy)
		}
	}
	return blocks
}

// IsUploaded returns true if the named block has been confirmed uploaded to S3.
func IsUploaded(localFile string) bool {
	globalS3Manifest.mu.RLock()
	defer globalS3Manifest.mu.RUnlock()
	entry, ok := globalS3Manifest.Entries[localFile]
	return ok && entry.UploadedAt > 0
}
