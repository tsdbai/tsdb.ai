# WAL Shipper

The WAL Shipper is a background process that continuously monitors the WAL directory for completed batch files, groups them into time-windowed blocks, and uploads them to the Deduplication Service. It also enforces local disk quotas to prevent unbounded disk growth.

## Responsibilities

- Polls the WAL directory for completed `.bin` batch files
- Groups WAL chunks into blocks spanning a configurable time window
- Uploads blocks to the Deduper via HTTP with exponential back-off retry
- Enforces a disk usage threshold — deletes oldest blocks when disk is full
- Age-based cleanup — removes blocks older than a configurable maximum age

## How It Works

```
WAL Directory
     │  (poll every 10s)
     ▼
┌──────────────┐
│  WAL Shipper │ — groups chunks into N-minute windows
└──────────────┘
     │  HTTP POST
     ▼
Deduplication Service (:8084)
```

The Shipper reads completed WAL files (files not currently being written to), packages them into a block JSON payload covering a time window (default 2 minutes), and POSTs to the Deduper. On failure it retries up to `max_retries` times with exponential back-off starting at `initial_backoff_ms`.

## Configuration Reference

| Setting | Default | Description |
|---|---|---|
| `poll_interval_s` | 10 | How often to scan for completed WAL files |
| `block_time_window_min` | 2 | Time window per block (smaller = more granular) |
| `max_retries` | 5 | HTTP retry limit before re-queuing |
| `initial_backoff_ms` | 500 | First retry delay (doubles each attempt) |
| `upload_workers` | 4 | Parallel upload goroutines |
| `upload_queue_capacity` | 100 | Pending job buffer depth |
| `cleanup_interval_s` | 10 | Disk-usage policy evaluation interval |
| `disk_usage_threshold_pct` | 90.0 | Emergency cleanup threshold |
| `max_block_age_minutes` | 1440 | Maximum age of a WAL block before deletion |

```yaml
shipper:
  poll_interval_s: 10
  block_time_window_min: 2
  max_retries: 5
  initial_backoff_ms: 500
  upload_workers: 4
  upload_queue_capacity: 100
  cleanup_interval_s: 10
  disk_usage_threshold_pct: 90.0
  max_block_age_minutes: 1440
```

## Disk Safety

When disk usage reaches `disk_usage_threshold_pct` (default 90%), the Shipper deletes the oldest local blocks until usage drops 5 percentage points below the threshold. This prevents the host from running out of disk even if the Deduper is unreachable for an extended period.

## Production Notes

- Raise `max_block_age_minutes` to `43200`+ (30 days) in production — the default 1440 is suitable for development
- Raise `upload_workers` to `8`–`16` on fast networks with many concurrent series
- If the Deduper is temporarily unreachable, blocks queue up to `upload_queue_capacity` before back-pressure is applied
