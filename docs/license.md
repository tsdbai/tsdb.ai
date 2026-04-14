# Licensing

TSDB.ai uses a statically-signed offline license system. Licenses are Ed25519-signed JWTs that are verified locally — no license server, no network call, no Docker hostname binding issues.

## License Format

```
TSDB1.<base64url(JSON payload)>.<base64url(Ed25519 signature)>
```

The payload contains:

```json
{
  "customer": "Acme Corp",
  "email": "admin@acme.com",
  "tier": "pro",
  "features": ["alert_builder", "chat_integrations", "causal_graph"],
  "issued": "2026-04-07",
  "expires": "2027-04-07"
}
```

## Installing a License

Add the license key to `tsdb.yaml`:

```yaml
license:
  key: "TSDB1.eyJ..."
```

Restart TSDB.ai. The admin panel reads `/internal/license` and updates immediately.

## Grace Period

When a license expires, TSDB.ai enters a **30-day grace period**. Pro features remain fully accessible. After 30 days, Pro features are hard-blocked until a new license is installed.

## UI Indicators

The admin panel surfaces license status in multiple places:

| State | Indicator |
|---|---|
| Valid license | `PRO` amber badge in footer |
| ≤ 30 days remaining | Yellow warning banner (dismissable) |
| ≤ 7 days remaining | Red danger banner (dismissable) |
| Expired, in grace period | Vibrant red banner (non-dismissable) + `PRO GRACE` footer badge |
| Hard blocked (past grace) | Maximum red banner (non-dismissable) + `FREE • UNLICENSED` footer |

## Generating a License (Self-Hosted / Internal)

If you are managing your own license issuance:

```bash
# Generate a keypair (run once)
node tools/gen-keypair.js
# → saves tsdb_private.key.json
# → prints public key hex (embed in license.go)

# Issue a license
node tools/gen-license.js \
  --customer "Acme Corp" \
  --email "admin@acme.com" \
  --months 12
```

The public key is embedded at compile time in `license.go`. The private key never leaves your issuance environment.

## Purchasing

Visit [tsdb.ai/pro](https://tsdb.ai/pro) to purchase an annual Pro license.
