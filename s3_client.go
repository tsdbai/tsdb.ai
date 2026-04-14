package main

// =============================================================================
// TSDB.ai S3 Client — pure stdlib, zero external dependencies
//
// Implements the subset of the S3 REST API required for tiered LTS:
//   PutObject        — upload a canonical block
//   GetObject        — download a block for query-time cache fill
//   HeadObject       — check whether a block exists on S3
//   ListObjects      — enumerate S3 keys under a prefix (catalog rebuild)
//   PutObjectMultipart — for blocks larger than Cfg.S3.MultipartThresholdMB
//
// Authentication uses AWS Signature Version 4 (SigV4).  Credentials are
// resolved in this order:
//   1. Cfg.S3.AccessKeyID / Cfg.S3.SecretAccessKey (from tsdb.yaml)
//   2. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY environment variables
//
// Compatible with:
//   - AWS S3 (virtual-hosted style, regional endpoints)
//   - MinIO / self-hosted (path style, custom endpoint)
//   - Cloudflare R2 (virtual-hosted, custom endpoint)
//   - Any S3-compatible service that supports SigV4
// =============================================================================

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io/ioutil"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// S3Client
// ---------------------------------------------------------------------------

// S3Client is a lightweight S3 REST client backed by net/http.
// Construct one with NewS3Client(); the instance is safe for concurrent use.
type S3Client struct {
	accessKey   string
	secretKey   string
	region      string
	bucket      string
	prefix      string
	endpoint    string // resolved base URL, e.g. "https://s3.us-east-1.amazonaws.com"
	usePathStyle bool
	httpClient  *http.Client
}

// S3ObjectInfo is a summary of a single object returned by ListObjects.
type S3ObjectInfo struct {
	Key          string
	Size         int64
	LastModified time.Time
}

// NewS3Client builds a client from the current global Cfg.S3.
// Returns an error if the bucket is empty or credentials cannot be resolved.
func NewS3Client() (*S3Client, error) {
	cfg := &Cfg.S3

	ak := cfg.AccessKeyID
	if ak == "" {
		ak = os.Getenv("AWS_ACCESS_KEY_ID")
	}
	sk := cfg.SecretAccessKey
	if sk == "" {
		sk = os.Getenv("AWS_SECRET_ACCESS_KEY")
	}
	if ak == "" || sk == "" {
		return nil, fmt.Errorf("[S3] credentials not found in config or environment")
	}
	if cfg.Bucket == "" {
		return nil, fmt.Errorf("[S3] bucket name is required")
	}

	return &S3Client{
		accessKey:    ak,
		secretKey:    sk,
		region:       cfg.Region,
		bucket:       cfg.Bucket,
		prefix:       cfg.Prefix,
		endpoint:     cfg.ResolvedEndpoint(),
		usePathStyle: cfg.UsePathStyle,
		httpClient:   &http.Client{},
	}, nil
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

// PutObject uploads data to key (relative to the configured prefix).
// Uses a single PUT for objects below Cfg.S3.MultipartThresholdMB, multipart
// for larger objects.
func (c *S3Client) PutObject(key string, data []byte) error {
	thresholdBytes := int64(Cfg.S3.MultipartThresholdMB) * 1024 * 1024
	if int64(len(data)) > thresholdBytes {
		return c.putObjectMultipart(key, data)
	}
	return c.putObjectSingle(key, data)
}

// GetObject downloads and returns the body of the object at key.
func (c *S3Client) GetObject(key string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), Cfg.S3.DownloadTimeout())
	defer cancel()

	req, err := c.newRequest(ctx, "GET", key, nil, "")
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("[S3] GET %s: %w", key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("[S3] GET %s: object not found (404)", key)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := ioutil.ReadAll(resp.Body)
		return nil, fmt.Errorf("[S3] GET %s: status %d: %s", key, resp.StatusCode, s3ErrorMessage(body))
	}
	return ioutil.ReadAll(resp.Body)
}

// HeadObject checks whether key exists on S3.
// Returns (exists bool, sizeBytes int64, err error).
func (c *S3Client) HeadObject(key string) (bool, int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), Cfg.S3.UploadTimeout())
	defer cancel()

	req, err := c.newRequest(ctx, "HEAD", key, nil, "")
	if err != nil {
		return false, 0, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, 0, fmt.Errorf("[S3] HEAD %s: %w", key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return false, 0, nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, 0, fmt.Errorf("[S3] HEAD %s: status %d", key, resp.StatusCode)
	}
	var size int64
	fmt.Sscanf(resp.Header.Get("Content-Length"), "%d", &size)
	return true, size, nil
}

// ListObjects returns all objects whose keys start with prefix (scoped further
// by c.prefix).  Handles pagination transparently (1000-object pages).
func (c *S3Client) ListObjects(prefix string) ([]S3ObjectInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), Cfg.S3.DownloadTimeout())
	defer cancel()

	fullPrefix := c.prefix + prefix
	var results []S3ObjectInfo
	continuationToken := ""

	for {
		q := url.Values{}
		q.Set("list-type", "2")
		q.Set("prefix", fullPrefix)
		q.Set("max-keys", "1000")
		if continuationToken != "" {
			q.Set("continuation-token", continuationToken)
		}

		req, err := c.newRequestWithQuery(ctx, "GET", "", q, nil, "")
		if err != nil {
			return nil, err
		}
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("[S3] ListObjects: %w", err)
		}
		body, _ := ioutil.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("[S3] ListObjects: status %d: %s", resp.StatusCode, s3ErrorMessage(body))
		}

		var listResult s3ListBucketResult
		if err := xml.Unmarshal(body, &listResult); err != nil {
			return nil, fmt.Errorf("[S3] ListObjects: XML parse error: %w", err)
		}
		for _, obj := range listResult.Contents {
			results = append(results, S3ObjectInfo{
				Key:          obj.Key,
				Size:         obj.Size,
				LastModified: obj.LastModified,
			})
		}
		if !listResult.IsTruncated {
			break
		}
		continuationToken = listResult.NextContinuationToken
	}
	return results, ctx.Err()
}

// FullKey returns the full S3 key for a block file basename.
// e.g. "1717200000_1717207200_a3f9c12b.json" → "blocks/1717200000_…"
func (c *S3Client) FullKey(basename string) string {
	return c.prefix + basename
}

// ---------------------------------------------------------------------------
// Single-part PUT
// ---------------------------------------------------------------------------

func (c *S3Client) putObjectSingle(key string, data []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), Cfg.S3.UploadTimeout())
	defer cancel()

	bodyHash := sha256Hex(data)
	req, err := c.newRequest(ctx, "PUT", key, data, bodyHash)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("[S3] PUT %s: %w", key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := ioutil.ReadAll(resp.Body)
		return fmt.Errorf("[S3] PUT %s: status %d: %s", key, resp.StatusCode, s3ErrorMessage(body))
	}
	return nil
}

// ---------------------------------------------------------------------------
// Multipart PUT  (CreateMultipartUpload → UploadPart × N → CompleteMultipartUpload)
// ---------------------------------------------------------------------------

type s3CompletedPart struct {
	PartNumber int
	ETag       string
}

func (c *S3Client) putObjectMultipart(key string, data []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), Cfg.S3.UploadTimeout())
	defer cancel()

	// --- 1. Initiate upload ---
	uploadID, err := c.createMultipartUpload(ctx, key)
	if err != nil {
		return err
	}

	// --- 2. Upload parts ---
	partSize := int64(Cfg.S3.MultipartPartSizeMB) * 1024 * 1024
	if partSize <= 0 {
		partSize = 50 * 1024 * 1024
	}
	var completedParts []s3CompletedPart
	for partNum := 1; ; partNum++ {
		start := int64(partNum-1) * partSize
		if start >= int64(len(data)) {
			break
		}
		end := start + partSize
		if end > int64(len(data)) {
			end = int64(len(data))
		}
		chunk := data[start:end]
		etag, err := c.uploadPart(ctx, key, uploadID, partNum, chunk)
		if err != nil {
			_ = c.abortMultipartUpload(ctx, key, uploadID)
			return fmt.Errorf("[S3] multipart part %d: %w", partNum, err)
		}
		completedParts = append(completedParts, s3CompletedPart{PartNumber: partNum, ETag: etag})
	}

	// --- 3. Complete ---
	return c.completeMultipartUpload(ctx, key, uploadID, completedParts)
}

func (c *S3Client) createMultipartUpload(ctx context.Context, key string) (string, error) {
	q := url.Values{"uploads": {""}}
	req, err := c.newRequestWithQuery(ctx, "POST", key, q, nil, "")
	if err != nil {
		return "", err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("[S3] CreateMultipartUpload: %w", err)
	}
	body, _ := ioutil.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("[S3] CreateMultipartUpload: status %d: %s", resp.StatusCode, s3ErrorMessage(body))
	}
	var result struct {
		UploadId string `xml:"UploadId"`
	}
	if err := xml.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("[S3] CreateMultipartUpload: XML parse: %w", err)
	}
	return result.UploadId, nil
}

func (c *S3Client) uploadPart(ctx context.Context, key, uploadID string, partNum int, data []byte) (string, error) {
	q := url.Values{
		"partNumber": {fmt.Sprintf("%d", partNum)},
		"uploadId":   {uploadID},
	}
	bodyHash := sha256Hex(data)
	req, err := c.newRequestWithQuery(ctx, "PUT", key, q, data, bodyHash)
	if err != nil {
		return "", err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("[S3] UploadPart %d: %w", partNum, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := ioutil.ReadAll(resp.Body)
		return "", fmt.Errorf("[S3] UploadPart %d: status %d: %s", partNum, resp.StatusCode, s3ErrorMessage(body))
	}
	return strings.Trim(resp.Header.Get("ETag"), `"`), nil
}

func (c *S3Client) completeMultipartUpload(ctx context.Context, key, uploadID string, parts []s3CompletedPart) error {
	type xmlPart struct {
		XMLName    xml.Name `xml:"Part"`
		PartNumber int      `xml:"PartNumber"`
		ETag       string   `xml:"ETag"`
	}
	type xmlBody struct {
		XMLName xml.Name  `xml:"CompleteMultipartUpload"`
		Parts   []xmlPart `xml:"Part"`
	}
	body := xmlBody{}
	for _, p := range parts {
		body.Parts = append(body.Parts, xmlPart{PartNumber: p.PartNumber, ETag: p.ETag})
	}
	xmlBytes, err := xml.Marshal(body)
	if err != nil {
		return fmt.Errorf("[S3] CompleteMultipartUpload marshal: %w", err)
	}
	xmlBytes = append([]byte(xml.Header), xmlBytes...)

	q := url.Values{"uploadId": {uploadID}}
	bodyHash := sha256Hex(xmlBytes)
	req, err := c.newRequestWithQuery(ctx, "POST", key, q, xmlBytes, bodyHash)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/xml")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("[S3] CompleteMultipartUpload: %w", err)
	}
	respBody, _ := ioutil.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("[S3] CompleteMultipartUpload: status %d: %s", resp.StatusCode, s3ErrorMessage(respBody))
	}
	return nil
}

func (c *S3Client) abortMultipartUpload(ctx context.Context, key, uploadID string) error {
	q := url.Values{"uploadId": {uploadID}}
	req, err := c.newRequestWithQuery(ctx, "DELETE", key, q, nil, "")
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// ---------------------------------------------------------------------------
// Request construction + AWS SigV4 signing
// ---------------------------------------------------------------------------

func (c *S3Client) newRequest(ctx context.Context, method, key string, body []byte, bodyHash string) (*http.Request, error) {
	return c.newRequestWithQuery(ctx, method, key, nil, body, bodyHash)
}

func (c *S3Client) newRequestWithQuery(ctx context.Context, method, key string, query url.Values, body []byte, bodyHash string) (*http.Request, error) {
	rawURL := c.buildURL(key, query)
	var bodyReader *bytes.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	} else {
		bodyReader = bytes.NewReader(nil)
	}

	req, err := http.NewRequestWithContext(ctx, method, rawURL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("[S3] build request: %w", err)
	}

	now := time.Now().UTC()
	dateStamp := now.Format("20060102")
	amzDate := now.Format("20060102T150405Z")

	if bodyHash == "" {
		if body != nil {
			bodyHash = sha256Hex(body)
		} else {
			bodyHash = sha256Hex(nil)
		}
	}

	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", bodyHash)
	req.Header.Set("Host", c.hostHeader())

	c.signRequest(req, method, key, query, bodyHash, dateStamp, amzDate)
	return req, nil
}

// buildURL constructs the full request URL, honouring path vs virtual-hosted style.
func (c *S3Client) buildURL(key string, query url.Values) string {
	fullKey := c.prefix + key
	// Remove any double-slash that would arise if key already starts with prefix
	if strings.HasPrefix(key, c.prefix) {
		fullKey = key
	}
	// Strip leading slash
	fullKey = strings.TrimPrefix(fullKey, "/")

	var rawURL string
	if c.usePathStyle {
		rawURL = c.endpoint + "/" + c.bucket + "/" + fullKey
	} else {
		// Virtual-hosted: https://bucket.s3.region.amazonaws.com/key
		base := c.endpoint
		// Insert bucket subdomain for native AWS-style endpoints
		if strings.Contains(base, "amazonaws.com") && !strings.HasPrefix(base, "https://"+c.bucket+".") {
			base = strings.Replace(base, "https://", "https://"+c.bucket+".", 1)
		} else if !strings.Contains(base, c.bucket) {
			// Non-AWS custom endpoint (R2, etc.) — use path style for the bucket
			rawURL = c.endpoint + "/" + c.bucket + "/" + fullKey
		}
		if rawURL == "" {
			rawURL = base + "/" + fullKey
		}
	}

	if len(query) > 0 {
		rawURL += "?" + query.Encode()
	}
	return rawURL
}

func (c *S3Client) hostHeader() string {
	if c.usePathStyle {
		u, _ := url.Parse(c.endpoint)
		return u.Host
	}
	// Virtual-hosted: bucket.s3.region.amazonaws.com
	u, _ := url.Parse(c.endpoint)
	host := u.Host
	if strings.Contains(host, "amazonaws.com") {
		return c.bucket + "." + host
	}
	return host
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------

func (c *S3Client) signRequest(req *http.Request, method, key string, query url.Values, payloadHash, dateStamp, amzDate string) {
	// 1. Canonical headers (must be sorted, lowercase)
	signedHeaderNames := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	sort.Strings(signedHeaderNames)

	var canonicalHeaders strings.Builder
	for _, h := range signedHeaderNames {
		canonicalHeaders.WriteString(h)
		canonicalHeaders.WriteString(":")
		canonicalHeaders.WriteString(strings.TrimSpace(req.Header.Get(h)))
		canonicalHeaders.WriteString("\n")
	}
	signedHeaders := strings.Join(signedHeaderNames, ";")

	// 2. Canonical query string (keys sorted, percent-encoded)
	canonicalQS := ""
	if query != nil {
		canonicalQS = query.Encode()
	}

	// 3. Canonical URI
	canonicalURI := "/" + strings.TrimPrefix(req.URL.Path, "/")

	// 4. Canonical request
	canonicalRequest := strings.Join([]string{
		method,
		canonicalURI,
		canonicalQS,
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")
	crHash := sha256Hex([]byte(canonicalRequest))

	// 5. String to sign
	credentialScope := dateStamp + "/" + c.region + "/s3/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		crHash,
	}, "\n")

	// 6. Signing key (derived from secret key + date + region + service)
	signingKey := deriveSigningKey(c.secretKey, dateStamp, c.region, "s3")

	// 7. Signature
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	// 8. Authorization header
	auth := fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		c.accessKey, credentialScope, signedHeaders, signature,
	)
	req.Header.Set("Authorization", auth)
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

func hmacSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

func sha256Hex(data []byte) string {
	if data == nil {
		data = []byte{}
	}
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func deriveSigningKey(secretKey, dateStamp, region, service string) []byte {
	kDate    := hmacSHA256([]byte("AWS4"+secretKey), []byte(dateStamp))
	kRegion  := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	return kSigning
}

// ---------------------------------------------------------------------------
// XML response types
// ---------------------------------------------------------------------------

type s3ListBucketResult struct {
	XMLName               xml.Name    `xml:"ListBucketResult"`
	IsTruncated           bool        `xml:"IsTruncated"`
	NextContinuationToken string      `xml:"NextContinuationToken"`
	Contents              []s3Object  `xml:"Contents"`
}

type s3Object struct {
	Key          string    `xml:"Key"`
	Size         int64     `xml:"Size"`
	LastModified time.Time `xml:"LastModified"`
}

// s3ErrorMessage extracts the <Message> text from an S3 XML error body,
// falling back to the raw body if parsing fails.
func s3ErrorMessage(body []byte) string {
	var errResp struct {
		Message string `xml:"Message"`
	}
	if xml.Unmarshal(body, &errResp) == nil && errResp.Message != "" {
		return errResp.Message
	}
	if len(body) > 256 {
		return string(body[:256])
	}
	return string(body)
}
