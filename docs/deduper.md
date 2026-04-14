# Deduplication Service

The Deduplication Service receives staged blocks from the WAL Shipper, deduplicates any overlapping series entries, and writes canonical long-term blocks to disk. It is the gateway between the hot write path and long-term storage.

## Responsibilities

- Accepts staged blocks from the WAL Shipper via `POST /ingest_block`
- Deduplicates overlapping or duplicate series chunks within a block
- Writes deduplicated output as canonical blocks to `blocks/canonical/`
- Runs a periodic retention policy — evicts canonical blocks older than the configured maximum age
- Triggers S3 upload of each canonical block when S3 is enabled (see [S3 / Object Storage](./s3.md))

## Port

`8084` (default, configurable via `server.deduper_port`)

## Data Flow

```
WAL Shipper
     │  POST /ingest_block
     ▼
┌─────────────────────┐
│  Deduper Service    │
│  - deduplicates     │
│  - merges overlaps  │
└─────────────────────┘
     │
     ├──▶ blocks/canonical/   (local disk)
     │
     └──▶ S3 (if enabled)
```

## Retention Policy

The Deduper runs a background retention checker on the `blocks/canonical/` directory. Any block whose timestamp is older than `max_canonical_age_minutes` is deleted. The check runs every `retention_check_interval_min` minutes.

| Setting | Default | Description |
|---|---|---|
| `retention_check_interval_min` | 10 | How often retention is evaluated |
| `max_canonical_age_minutes` | 43200 | Max block age (default = 30 days) |

```yaml
deduper:
  retention_check_interval_min: 10
  max_canonical_age_minutes: 43200   # 30 days
```

## Common Presets

| Use Case | `max_canonical_age_minutes` |
|---|---|
| Development | 10080 (7 days) |
| Standard production | 43200 (30 days) |
| Extended retention | 129600 (90 days) |
| Unlimited (S3 as source of truth) | 0 (keep forever locally) |

## Notes

- When S3 is enabled, the Deduper uploads every canonical block immediately after writing it locally. Once the `retention_after_upload_min` window expires, the local copy is evicted and future queries fetch from S3
- The Deduper is an internal service — it does not need to be publicly accessible
- Block filenames encode their time range, allowing the Query Gateway to skip blocks that don't overlap a query's time window
