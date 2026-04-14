package main

import (
	"math"
)

// --- Model Definitions (Omitted for brevity - Unchanged) ---

// Model 0: Constant Model (1 Parameter: c)
func constantModel(t []float64, params []float64) []float64 {
	c := params[0]
	result := make([]float64, len(t))
	for i := range result {
		result[i] = c
	}
	return result
}

// Model 1: Linear Model (2 Parameters: m, c)
func linearModel(t []float64, params []float64) []float64 {
	m := params[0]
	c := params[1]
	result := make([]float64, len(t))
	for i := range t {
		result[i] = m*t[i] + c
	}
	return result
}

// Model 2: Quadratic Model (3 Parameters: a, b, c)
func quadraticModel(t []float64, params []float64) []float64 {
	a := params[0]
	b := params[1]
	c := params[2]
	result := make([]float64, len(t))
	for i := range t {
		result[i] = a*t[i]*t[i] + b*t[i] + c
	}
	return result
}

// --- Utility Functions (Omitted for brevity - Unchanged) ---

// calculateRMSE computes the Root Mean Square Error
func calculateRMSE(original, reconstructed []float64) float64 {
	if len(original) == 0 {
		return 0.0
	}
	var sumSq float64
	for i := range original {
		diff := original[i] - reconstructed[i]
		sumSq += diff * diff
	}
	return math.Sqrt(sumSq / float64(len(original)))
}

// getAverage computes the mean of the values (used for constant model baseline)
func getAverage(values []float64) float64 {
	var sum float64
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

// simpleLinearFit performs a simple least-squares linear regression (y = mx + c)
func simpleLinearFit(t, v []float64) (m, c float64) {
    avgT := getAverage(t)
    avgV := getAverage(v)

    var sumTV, sumTSq float64
    for i := range t {
        sumTV += (t[i] - avgT) * (v[i] - avgV)
        sumTSq += (t[i] - avgT) * (t[i] - avgT)
    }

    if sumTSq == 0 {
        m = 0
    } else {
        m = sumTV / sumTSq
    }
    c = avgV - m*avgT
    return m, c
}


// CompressedChunk holds the resulting model parameters and metadata
type CompressedChunk struct {
	MetricString string
	ModelID      int
	Params       []float64 // Stored Model Parameters
	RMSE         float64
	TBase        float64 // Start timestamp of the chunk
	RawSize      int
	ModelSize    int
}

// AdaptiveFit attempts to fit the simplest model that meets the RMSE tolerance.
func AdaptiveFit(t, v []float64, metric string, rmseTolerance float64) CompressedChunk {
	if len(t) == 0 {
		return CompressedChunk{}
	}

	// Calculate raw size based on 8 bytes/sample (64-bit float baseline)
	rawSize := len(v) * 8
	tBase := t[0]
	
	// Create relative time slice starting from zero for stability
	tRel := make([]float64, len(t))
	for i := range t {
		tRel[i] = t[i] - tBase
	}
	
	// --- Adaptive Search (omitted for brevity) ---
    
	// 1. Try Constant Model (Model ID 0, 1 Parameter)
	avg := getAverage(v)
	paramsC := []float64{avg}
	vRecC := constantModel(tRel, paramsC)
	rmseC := calculateRMSE(v, vRecC)

	if rmseC < rmseTolerance {
		paddedParams := []float64{avg, 0.0, 0.0} 
		return CompressedChunk{
			MetricString: metric,
			ModelID:      0,
			Params:       paddedParams,
			RMSE:         rmseC,
			TBase:        tBase,
			RawSize:      rawSize,
			ModelSize:    1*4 + 1, // 1 param * 4 bytes + 1 byte ID
		}
	}

	// 2. Try Linear Model (Model ID 1, 2 Parameters)
	m, c := simpleLinearFit(tRel, v)
	paramsL := []float64{m, c}
	vRecL := linearModel(tRel, paramsL)
	rmseL := calculateRMSE(v, vRecL)

	if rmseL < rmseTolerance {
		paddedParams := []float64{m, c, 0.0}
		return CompressedChunk{
			MetricString: metric,
			ModelID:      1,
			Params:       paddedParams,
			RMSE:         rmseL,
			TBase:        tBase,
			RawSize:      rawSize,
			ModelSize:    2*4 + 1, // 2 params * 4 bytes + 1 byte ID
		}
	}

	// 3. Fallback to Quadratic Model (Model ID 2, 3 Parameters)
	paramsQ := []float64{0.0, m, c} // Use 0 for 'a', m for 'b', c for 'c'
	vRecQ := quadraticModel(tRel, paramsQ)
	rmseQ := calculateRMSE(v, vRecQ)

	return CompressedChunk{
		MetricString: metric,
		ModelID:      2,
		Params:       paramsQ,
		RMSE:         rmseQ,
		TBase:        tBase,
		RawSize:      rawSize,
		ModelSize:    3*4 + 1, // 3 params * 4 bytes + 1 byte ID
	}
}

// --- NEW: Indexing and Versioning Structures ---

// IndexUpdate is used to signal the Index Queue that a block has been created or deleted.
type IndexUpdate struct {
	S3Key    string `json:"s3_key"`
	Action   string `json:"action"` // "CREATE" or "DELETE"
	Version  int64  `json:"version"`
}

// SeriesIndexEntry represents the metadata required for the LTS index.
type SeriesIndexEntry struct {
	SeriesHash    string           `json:"series_hash"` // Symbolic ID replacement
	StartTime     float64          `json:"start_time"`
	EndTime       float64          `json:"end_time"`
	S3Key         string           `json:"s3_key"`      // Path to the compressed block file
	Version       int64            `json:"version"`     // Monotonic timestamp for conflict resolution (Unix Nano)
	StorageMode   string           `json:"storage_mode"`// "LOCAL" or "S3"
}