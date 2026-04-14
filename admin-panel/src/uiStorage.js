/**
 * uiStorage.js — Persistence layer for AIDashboard UI state.
 *
 * Reads and writes ui_state.json on the TSDB server via:
 *   GET  /internal/ui_state  → returns current JSON (or empty skeleton)
 *   POST /internal/ui_state  → saves full JSON body atomically
 *
 * The JSON schema:
 * {
 *   version: 1,
 *   sessions: [
 *     {
 *       id: string,          // uuid
 *       label: string,       // user-visible name
 *       savedAt: string,     // ISO 8601
 *       tabs: TabSpec[],
 *       messages: Message[]  // only role=user|assistant
 *     }
 *   ],
 *   dashboards: [],          // reserved for future named dashboard snapshots
 *   currentSessionId: string | null
 * }
 */

// Empty BASE — Vite proxies /internal/* → port 8080 in dev.
const BASE = '';

/**
 * Load persisted UI state from the server.
 * Returns the parsed object, or the default skeleton on any error.
 */
export async function loadUIState() {
  try {
    const res = await fetch(`${BASE}/internal/ui_state`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.warn('[uiStorage] GET /internal/ui_state returned', res.status);
      return defaultState();
    }
    const data = await res.json();
    return data;
  } catch (err) {
    console.warn('[uiStorage] Could not load UI state:', err.message);
    return defaultState();
  }
}

/**
 * Save full UI state to the server.
 * Returns true on success, false on failure (non-throwing).
 *
 * @param {object} state  Full UI state matching the schema above.
 */
export async function saveUIState(state) {
  try {
    const res = await fetch(`${BASE}/internal/ui_state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (!res.ok) {
      console.warn('[uiStorage] POST /internal/ui_state returned', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[uiStorage] Could not save UI state:', err.message);
    return false;
  }
}

/**
 * Helper — generate a simple unique session ID.
 */
export function newSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Helper — generate a human-readable default session label.
 */
export function defaultSessionLabel() {
  const now = new Date();
  return now.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function defaultState() {
  return {
    version: 1,
    sessions: [],
    dashboards: [],
    currentSessionId: null,
  };
}
