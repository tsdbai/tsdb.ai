package main

// =============================================================================
// Protocol & Compile-Time Constants
// Extracted into their own file so all service binaries can include this
// without pulling in main.go (which defines its own main() function).
// =============================================================================

const (
	// Protocol-level constants — changing these breaks on-disk/wire compatibility.
	WALMagic          = uint32(0x54534442) // "TSDB" little-endian magic for .bin WAL files
	CheckpointVersion = 2                  // checkpoint schema version
	StorageMode       = "LOCAL"            // storage backend (not yet user-selectable)

	// Shard and seasonal-slot counts must be compile-time constants because
	// they are used as array lengths.  They mirror the defaults in config.go
	// and should not be changed without also updating config defaults + data migration.
	numShards     = 256 // Cfg.Ingestion.NumShards default
	seasonalSlots = 168 // Cfg.Anomaly.SeasonalSlots default (24h * 7 days)
)
