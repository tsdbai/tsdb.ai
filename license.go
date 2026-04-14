package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

const licensePublicKey = "0d383711f67dcd7cdf81551adc2bf2035523875d524a1694064791e769bec0af"

// ── Types ─────────────────────────────────────────────────────────────────────

type licensePayload struct {
	Customer string   `json:"customer"`
	Email    string   `json:"email"`
	Tier     string   `json:"tier"`
	Features []string `json:"features"`
	Issued   string   `json:"issued"`
	Expires  string   `json:"expires"`
}

// LicenseStatus is returned by ValidateLicense and exposed via /internal/license.
type LicenseStatus struct {
	Valid        bool     `json:"valid"`
	Customer     string   `json:"customer,omitempty"`
	Email        string   `json:"email,omitempty"`
	Tier         string   `json:"tier,omitempty"`
	Features     []string `json:"features,omitempty"`
	IssuedAt     string   `json:"issued_at,omitempty"`
	ExpiresAt    string   `json:"expires_at,omitempty"`
	DaysLeft     int      `json:"days_left,omitempty"`
	ExpiringSoon bool     `json:"expiring_soon,omitempty"` // true when ≤ 30 days remain
	Expired      bool     `json:"expired,omitempty"`
	Error        string   `json:"error,omitempty"`
}

// ── Validator ─────────────────────────────────────────────────────────────────

// ValidateLicense verifies a TSDB1 license key entirely offline using the
// embedded Ed25519 public key. No network call is made.
//
// Key format:  TSDB1.<base64url(json_payload)>.<base64url(ed25519_sig)>
func ValidateLicense(key string) LicenseStatus {
	if strings.TrimSpace(key) == "" {
		return LicenseStatus{Valid: false, Error: "no license key configured in tsdb.yaml"}
	}

	parts := strings.Split(key, ".")
	if len(parts) != 3 || parts[0] != "TSDB1" {
		return LicenseStatus{Valid: false, Error: "unrecognized license format"}
	}

	// ── decode payload ────────────────────────────────────────────────────────
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return LicenseStatus{Valid: false, Error: "license payload is corrupt"}
	}

	// ── decode signature ──────────────────────────────────────────────────────
	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return LicenseStatus{Valid: false, Error: "license signature is corrupt"}
	}

	// ── verify signature ──────────────────────────────────────────────────────
	pubKeyBytes, err := hex.DecodeString(licensePublicKey)
	if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
		return LicenseStatus{Valid: false, Error: "internal: invalid embedded public key"}
	}
	if !ed25519.Verify(ed25519.PublicKey(pubKeyBytes), payloadBytes, sigBytes) {
		return LicenseStatus{Valid: false, Error: "license signature invalid — key may be tampered"}
	}

	// ── parse payload ─────────────────────────────────────────────────────────
	var p licensePayload
	if err := json.Unmarshal(payloadBytes, &p); err != nil {
		return LicenseStatus{Valid: false, Error: "license payload could not be parsed"}
	}

	expires, err := time.Parse("2006-01-02", p.Expires)
	if err != nil {
		return LicenseStatus{Valid: false, Error: "license has invalid expiry date"}
	}

	now      := time.Now().UTC()
	daysLeft := int(expires.Sub(now).Hours() / 24)

	if now.After(expires) {
		return LicenseStatus{
			Valid:     false,
			Expired:   true,
			Customer:  p.Customer,
			Email:     p.Email,
			Tier:      p.Tier,
			ExpiresAt: p.Expires,
			DaysLeft:  0,
			Error:     "license expired on " + p.Expires,
		}
	}

	return LicenseStatus{
		Valid:        true,
		Customer:     p.Customer,
		Email:        p.Email,
		Tier:         p.Tier,
		Features:     p.Features,
		IssuedAt:     p.Issued,
		ExpiresAt:    p.Expires,
		DaysLeft:     daysLeft,
		ExpiringSoon: daysLeft <= 30,
	}
}

// HasFeature returns true if the license is valid and includes the named feature.
func (s LicenseStatus) HasFeature(name string) bool {
	if !s.Valid {
		return false
	}
	for _, f := range s.Features {
		if f == name {
			return true
		}
	}
	return false
}
