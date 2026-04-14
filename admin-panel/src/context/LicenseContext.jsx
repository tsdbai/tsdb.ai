import { createContext, useContext, useState, useEffect, useCallback } from 'react'

// ─── Context ──────────────────────────────────────────────────────────────────

const LicenseContext = createContext(null)

// ─── Derived state helpers ────────────────────────────────────────────────────

function deriveState(raw) {
  if (!raw) {
    return {
      loading:       true,
      raw:           null,
      isLicensed:    false,
      isExpired:     false,
      daysLeft:      0,
      daysSinceExpiry: 0,
      inGracePeriod: false,   // expired but within 30-day grace window
      hardBlocked:   false,   // expired + past grace — all pro features off
      isProActive:   false,   // true if pro features should be accessible
      bannerLevel:   null,    // null | 'warning' | 'danger' | 'expired' | 'blocked'
    }
  }

  const isLicensed = raw.valid === true
  const isExpired  = raw.expired === true

  // How many days since the license expired (0 if not expired)
  let daysSinceExpiry = 0
  if (isExpired && raw.expires_at) {
    daysSinceExpiry = Math.max(0, Math.floor((Date.now() - new Date(raw.expires_at)) / 86_400_000))
  }

  const inGracePeriod = isExpired && daysSinceExpiry <= 30
  const hardBlocked   = isExpired && daysSinceExpiry > 30
  const isProActive   = isLicensed || inGracePeriod  // pro features still work

  const daysLeft = raw.days_left ?? 0

  // Banner urgency
  let bannerLevel = null
  if (hardBlocked)                       bannerLevel = 'blocked'
  else if (inGracePeriod)                bannerLevel = 'expired'
  else if (isLicensed && daysLeft <= 7)  bannerLevel = 'danger'
  else if (isLicensed && daysLeft <= 30) bannerLevel = 'warning'

  return {
    loading:         false,
    raw,
    isLicensed,
    isExpired,
    daysLeft,
    daysSinceExpiry,
    inGracePeriod,
    hardBlocked,
    isProActive,
    bannerLevel,
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function LicenseProvider({ children }) {
  const [state, setState] = useState(deriveState(null))

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/internal/license', { signal: AbortSignal.timeout(4000) })
      if (!r.ok) throw new Error(r.status)
      const data = await r.json()
      setState(deriveState(data))
    } catch {
      // Server unreachable — don't override a previously loaded valid state,
      // but if we've never loaded anything yet flip loading off so the UI
      // doesn't hang showing a spinner forever
      setState(prev => prev.loading ? { ...deriveState({}), loading: false } : prev)
    }
  }, [])

  // Fetch on mount, then every 5 minutes
  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [refresh])

  return (
    <LicenseContext.Provider value={{ ...state, refresh }}>
      {children}
    </LicenseContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLicense() {
  const ctx = useContext(LicenseContext)
  if (!ctx) throw new Error('useLicense must be used within a LicenseProvider')
  return ctx
}
