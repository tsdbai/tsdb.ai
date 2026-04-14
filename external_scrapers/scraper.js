// tsdb.ai External Scraper — Node.js implementation
//
// NOTE: The Go binary (scraper_external.go) is the canonical production
// implementation. This Node.js version is provided as an alternative for
// environments where deploying a Go binary is not practical.
// All fixes applied here should be kept in sync with the Go version.

'use strict';

const http    = require('http');
const https   = require('https');
const { URL } = require('url');   // url.parse() is deprecated since Node 11
const process = require('process');

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------
const DEFAULT_INGEST_ENDPOINT = 'http://localhost:8080/ingest_samples';
const DEFAULT_SCRAPE_INTERVAL = 30;
const DEFAULT_SCRAPE_TIMEOUT  = 15;
const DEFAULT_JOB_LABEL       = 'external';
const MAX_BUFFER_SIZE_BYTES   = 50 * 1024 * 1024;  // 50 MB
const MAX_SCRAPE_BODY_BYTES   = 10 * 1024 * 1024;  // 10 MB per response

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let ingestEndpoint = DEFAULT_INGEST_ENDPOINT;
let jobLabel       = DEFAULT_JOB_LABEL;

let retryBuffer        = [];
let currentBufferSize  = 0;

// Self-monitoring counters (JS is single-threaded, no atomics needed)
const stats = { scraped: 0, sent: 0, dropped: 0, scrapeErr: 0, ingestErr: 0 };

// ---------------------------------------------------------------------------
// Label injection
// ---------------------------------------------------------------------------

/**
 * Stamp instance= and job= onto a Prometheus metric string so that samples
 * from different targets remain distinguishable inside the TSDB.
 *
 * Without this, two hosts exposing the same metric name produce identical
 * metric strings and silently overwrite each other.
 *
 * "http_requests_total{method=\"GET\"}" →
 *   "http_requests_total{instance=\"h:p\",job=\"j\",method=\"GET\"}"
 * "go_gc_duration_seconds" →
 *   "go_gc_duration_seconds{instance=\"h:p\",job=\"j\"}"
 */
function injectLabels(metricStr, instance, job) {
    const injected = `instance="${instance}",job="${job}"`;
    const idx = metricStr.lastIndexOf('}');
    if (idx !== -1) {
        const prefix = metricStr.slice(0, idx).replace(/[,\s]+$/, '');
        return `${prefix},${injected}}`;
    }
    return `${metricStr.trim()}{${injected}}`;
}

/**
 * Return "host:port" from a URL, filling in the scheme default if absent.
 */
function instanceFromURL(rawURL) {
    try {
        const u    = new URL(rawURL);
        const host = u.hostname;
        const port = u.port || (u.protocol === 'https:' ? '443' : '80');
        return `${host}:${port}`;
    } catch (_) {
        return rawURL;
    }
}

// ---------------------------------------------------------------------------
// Prometheus text-format parser
// ---------------------------------------------------------------------------

// Compiled once — not inside the parse function.
const RE_METRIC = /^([a-zA-Z_:][a-zA-Z0-9_:{}=,"/\.\-\[\]\s]+)\s+([0-9\.eE\+\-]+)/;

function parsePrometheusMetrics(data, instance, job) {
    const lines   = data.split('\n');
    const samples = [];
    const now     = Date.now() / 1000;

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;

        const m = RE_METRIC.exec(line);
        if (!m) continue;

        const value = parseFloat(m[2]);
        if (isNaN(value)) continue;

        samples.push({
            metric_string: injectLabels(m[1].trim(), instance, job),
            value,
            timestamp: now,
        });
    }
    return samples;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function postData(endpoint, data, timeoutMs) {
    return new Promise((resolve, reject) => {
        const u = new URL(endpoint);
        const options = {
            hostname: u.hostname,
            port:     u.port || (u.protocol === 'https:' ? 443 : 80),
            path:     u.pathname + u.search,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
            timeout: timeoutMs,
        };
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            res.on('data', () => {});  // drain so socket is reused
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`non-200 status: ${res.statusCode}`));
                } else {
                    resolve();
                }
            });
        });
        req.on('error',   (e) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('request timed out')); });
        req.write(data);
        req.end();
    });
}

function getData(targetUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
        const u = new URL(targetUrl);
        const options = {
            hostname: u.hostname,
            port:     u.port || (u.protocol === 'https:' ? 443 : 80),
            path:     u.pathname + u.search,
            method:   'GET',
            headers:  { Accept: 'text/plain;version=0.0.4,*/*' },
            timeout:  timeoutMs,
        };
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`non-200 status: ${res.statusCode}`));
                return;
            }
            let data = '';
            let received = 0;
            res.on('data', (chunk) => {
                received += chunk.length;
                if (received > MAX_SCRAPE_BODY_BYTES) {
                    // Prevent OOM from oversized responses; take what we have.
                    res.destroy();
                } else {
                    data += chunk;
                }
            });
            res.on('end',   () => resolve(data));
            res.on('error', (e) => reject(e));
        });
        req.on('error',   (e) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('request timed out')); });
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Ingestor communication
// ---------------------------------------------------------------------------

function addToBuffer(samples) {
    // Use actual serialised length for an accurate cap check.
    const sz = Buffer.byteLength(JSON.stringify(samples)) || samples.length * 512;
    if (currentBufferSize + sz > MAX_BUFFER_SIZE_BYTES) {
        console.log(`[${ts()}] CRITICAL: buffer full — dropping ${samples.length} samples.`);
        stats.dropped += samples.length;
        return;
    }
    retryBuffer.push(...samples);
    currentBufferSize += sz;
}

async function pushMetricsToIngestor(samples) {
    if (!samples || samples.length === 0) return;

    // Flush any backlog first (JS is single-threaded so no lock needed).
    if (retryBuffer.length > 0) {
        const pending = retryBuffer.slice();
        console.log(`[${ts()}] RECOVERY: flushing ${pending.length} buffered samples...`);
        try {
            await postData(ingestEndpoint, JSON.stringify(pending), 5000);
            console.log(`[${ts()}] RECOVERY: buffer flushed.`);
            retryBuffer = [];
            currentBufferSize = 0;
            stats.sent += pending.length;
        } catch (e) {
            console.log(`[${ts()}] RECOVERY FAILED: ${e.message} — buffering new samples.`);
            stats.ingestErr++;
            addToBuffer(samples);
            return;
        }
    }

    try {
        await postData(ingestEndpoint, JSON.stringify(samples), 5000);
        stats.sent += samples.length;
        console.log(`[${ts()}] Pushed ${samples.length} samples.`);
    } catch (e) {
        console.log(`[${ts()}] PUSH ERROR: ${e.message} — buffering ${samples.length} samples.`);
        stats.ingestErr++;
        addToBuffer(samples);
    }
}

// ---------------------------------------------------------------------------
// Scrape worker
// ---------------------------------------------------------------------------

async function scrapeTarget(targetUrl, timeoutMs) {
    const instance = instanceFromURL(targetUrl);
    const start    = Date.now();
    try {
        const body    = await getData(targetUrl, timeoutMs);
        const samples = parsePrometheusMetrics(body, instance, jobLabel);
        stats.scraped += samples.length;
        console.log(`[${ts()}] Scraped ${targetUrl} in ${((Date.now()-start)/1000).toFixed(3)}s — ${samples.length} samples`);
        await pushMetricsToIngestor(samples);
    } catch (e) {
        console.log(`[${ts()}] SCRAPE FAIL ${targetUrl}: ${e.message}`);
        stats.scrapeErr++;
    }
}

// ---------------------------------------------------------------------------
// Self-monitoring HTTP server
// ---------------------------------------------------------------------------

function startHealthServer(port) {
    const server = http.createServer((req, res) => {
        if (req.url === '/health') {
            const body = JSON.stringify({ status: 'ok', ingest_endpoint: ingestEndpoint });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);

        } else if (req.url === '/metrics') {
            const lines = [];
            const push = (name, help, type, val) => {
                lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${val}`, '');
            };
            push('scraper_samples_scraped_total',  'Total samples parsed from all targets',            'counter', stats.scraped);
            push('scraper_samples_sent_total',     'Samples successfully delivered to ingestor',       'counter', stats.sent);
            push('scraper_samples_dropped_total',  'Samples dropped because retry buffer was full',    'counter', stats.dropped);
            push('scraper_scrape_errors_total',    'Scrape attempts that failed',                      'counter', stats.scrapeErr);
            push('scraper_ingest_errors_total',    'Ingestor push attempts that failed',               'counter', stats.ingestErr);
            push('scraper_buffer_samples',         'Samples currently held in the retry buffer',       'gauge',   retryBuffer.length);
            push('scraper_buffer_bytes',           'Serialised bytes currently in the retry buffer',   'gauge',   currentBufferSize);
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
            res.end(lines.join('\n'));

        } else {
            res.writeHead(404);
            res.end();
        }
    });
    server.listen(port, () => {
        console.log(`[${ts()}] Self-monitoring → http://localhost:${port}/health  |  http://localhost:${port}/metrics`);
    });
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

function parseArgs() {
    const args = {};
    process.argv.slice(2).forEach(arg => {
        if (arg.startsWith('--')) {
            const eqIdx = arg.indexOf('=');
            if (eqIdx !== -1) {
                args[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
            } else {
                args[arg.slice(2)] = true;
            }
        }
    });
    return args;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function ts() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function main() {
    const args = parseArgs();

    // ingest endpoint (env → flag)
    ingestEndpoint = process.env.INGEST_ENDPOINT || DEFAULT_INGEST_ENDPOINT;
    if (args['ingest-endpoint']) ingestEndpoint = args['ingest-endpoint'];
    if (!ingestEndpoint) {
        console.error('Error: ingest endpoint required (--ingest-endpoint or INGEST_ENDPOINT)');
        process.exit(1);
    }

    // job label (env → flag → default)
    jobLabel = process.env.JOB_LABEL || DEFAULT_JOB_LABEL;
    if (args['job-label']) jobLabel = args['job-label'];

    // targets (env → flag)
    const targets = [];
    const parseList = (s) => s && s.split(',').forEach(u => { u = u.trim(); if (u) targets.push(u); });
    parseList(process.env.SCRAPE_URLS);
    parseList(args['scrape-urls']);
    if (targets.length === 0) {
        console.error('Error: no scrape targets (--scrape-urls or SCRAPE_URLS)');
        process.exit(1);
    }

    // interval
    let interval = parseInt(process.env.SCRAPE_INTERVAL_SECONDS, 10) || DEFAULT_SCRAPE_INTERVAL;
    if (args['scrape-interval-seconds']) interval = parseInt(args['scrape-interval-seconds'], 10) || interval;
    if (interval < 15) { console.log(`Warning: interval ${interval}s < 15s minimum; using 15s.`); interval = 15; }

    // timeout
    let timeout = parseInt(process.env.SCRAPE_TIMEOUT_SECONDS, 10) || DEFAULT_SCRAPE_TIMEOUT;
    if (args['scrape-timeout-seconds']) timeout = parseInt(args['scrape-timeout-seconds'], 10) || timeout;
    if (timeout >= interval) { timeout = interval - 1; console.log(`Warning: timeout capped to ${timeout}s.`); }
    const timeoutMs = timeout * 1000;

    // health server
    let healthPort = parseInt(process.env.HEALTH_PORT, 10) || 0;
    if (args['health-port']) healthPort = parseInt(args['health-port'], 10) || healthPort;
    if (healthPort > 0) startHealthServer(healthPort);

    console.log('--- tsdb.ai External Scraper (Node.js) ---');
    console.log(`Ingestor  : ${ingestEndpoint}`);
    console.log(`Targets   : ${targets.join(', ')}`);
    console.log(`Job label : ${jobLabel}`);
    console.log(`Interval  : ${interval}s  Timeout: ${timeout}s`);

    const runRound = () => targets.forEach(t => scrapeTarget(t, timeoutMs));

    runRound();  // immediate first scrape
    setInterval(runRound, interval * 1000);
}

main();
