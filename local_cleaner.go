package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"time"
	"strconv" 
	"strings" 
)

// BlockInfo holds metadata necessary for sorting and index update
type BlockInfo struct {
	Path      string
	Timestamp int64
}

// getDiskUsagePercent returns the percentage of disk used for the given path.
func getDiskUsagePercent(path string) (float64, error) {
	fs := syscall.Statfs_t{}
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0, fmt.Errorf("failed to statfs %s: %w", path, err)
	}

	// Calculate total and free bytes
	total := fs.Blocks * uint64(fs.Bsize)
	free := fs.Bfree * uint64(fs.Bsize) // Available blocks for unprivileged users

	if total == 0 {
		return 0, nil
	}

	used := total - free
	usagePercent := (float64(used) / float64(total)) * 100
	return usagePercent, nil
}

// listShippedBlocks lists all blocks in ShippedDir, sorted by age (oldest first).
func listShippedBlocks(dir string) ([]BlockInfo, error) {
	files, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	var blocks []BlockInfo
	for _, file := range files {
		if file.IsDir() {
			continue
		}
		
		// FIX: Accept both .gz (Blocks) and .json (Raw Chunks) for cleanup
		if !strings.HasSuffix(file.Name(), ".gz") && !strings.HasSuffix(file.Name(), ".json") {
			continue
		}

		// Filename format starts with timestamp: <timestamp>_...
		parts := strings.Split(file.Name(), "_")
		if len(parts) < 2 {
			continue
		}

		timestamp, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			continue // Skip files with unparsable timestamp
		}

		blocks = append(blocks, BlockInfo{
			Path:      filepath.Join(dir, file.Name()),
			Timestamp: timestamp,
		})
	}

	// Sort blocks by timestamp (oldest first)
	sort.Slice(blocks, func(i, j int) bool {
		return blocks[i].Timestamp < blocks[j].Timestamp
	})

	return blocks, nil
}

// performSpaceCleanup deletes blocks based on disk usage hitting a threshold.
func performSpaceCleanup(dir string, usageThreshold float64, indexQueue chan<- IndexUpdate) (int, error) {
	usage, err := getDiskUsagePercent(dir)
	if err != nil {
		return 0, err
	}
	
	if usage < usageThreshold {
		return 0, nil // No cleanup needed yet
	}
	
	blocks, err := listShippedBlocks(dir)
	if err != nil {
		return 0, err
	}

	deletedCount := 0
	targetUsage := usageThreshold - 5.0
	
	fmt.Printf("[CLEANUP] Emergency cleanup triggered. Usage: %.2f%%. Target: %.2f%%\n", usage, targetUsage)

	for _, block := range blocks {
		if usage <= targetUsage || deletedCount > len(blocks) {
			break
		}
		
		if err := os.Remove(block.Path); err != nil {
			fmt.Printf("[CLEANUP] ERROR deleting %s: %v\n", block.Path, err)
			continue
		}
		
		// Only notify index for .gz block deletion (canonical blocks), not raw chunks
		if strings.HasSuffix(block.Path, ".gz") {
			indexQueue <- IndexUpdate{
				S3Key:    filepath.Base(block.Path),
				Action:   "DELETE",
				Version:  time.Now().UnixNano(),
			}
		}

		deletedCount++
		usage, _ = getDiskUsagePercent(dir) 
	}
	
	fmt.Printf("[CLEANUP] Deleted %d oldest files. Current usage: %.2f%%\n", deletedCount, usage)
	return deletedCount, nil
}

// performTimeCleanup deletes blocks older than the specified duration.
func performTimeCleanup(dir string, maxAge time.Duration, indexQueue chan<- IndexUpdate) (int, error) {
	blocks, err := listShippedBlocks(dir)
	if err != nil {
		return 0, err
	}
	
	cutoffTime := time.Now().Add(-maxAge).Unix()
	deletedCount := 0
	
	for _, block := range blocks {
		if block.Timestamp < cutoffTime {
			if err := os.Remove(block.Path); err != nil {
				fmt.Printf("[CLEANUP] ERROR deleting %s: %v\n", block.Path, err)
				continue
			}
			
			// Only notify index for .gz block deletion
			if strings.HasSuffix(block.Path, ".gz") {
				indexQueue <- IndexUpdate{
					S3Key:    filepath.Base(block.Path),
					Action:   "DELETE",
					Version:  time.Now().UnixNano(),
				}
			}

			deletedCount++
		}
	}
	
	if deletedCount > 0 {
		fmt.Printf("[CLEANUP] Time-based retention: Deleted %d files older than %s.\n", deletedCount, maxAge.String())
	}
	return deletedCount, nil
}