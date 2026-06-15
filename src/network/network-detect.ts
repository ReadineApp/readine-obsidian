// START_MODULE_CONTRACT
// PURPOSE: Adapter over navigator.onLine + navigator.connection. Exposes Connection state and change subscription.
// SCOPE: src/network/network-detect.ts
// DEPENDS: none
// LINKS: UC-003, UC-004, UC-009, UC-017, V-M-NETWORK-DETECT
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// Connection - shape returned by getConnection()
// ConnectionType - union of recognized connection categories
// UnsubscribeFn - shape returned by onConnectionChange()
// getConnection - returns current network state
// onConnectionChange - subscribe to network state changes
// __resetConnectionCache - test helper to reset the cached connection state
// END_MODULE_MAP

// START_BLOCK_TYPES
export type ConnectionType = "wifi" | "cellular" | "none" | "unknown";

export interface Connection {
  type: ConnectionType;
  online: boolean;
  effectiveType?: string;
}

export type UnsubscribeFn = () => void;

/** Module-level cache: populated on first call, invalidated via onConnectionChange. */
let cachedConnection: Connection | null = null;

/** Test-only: reset the cache so the next getConnection() re-reads navigator. */
export function __resetConnectionCache(): void {
  cachedConnection = null;
}

interface NetworkInformationLike {
  type?: string;
  effectiveType?: string;
  addEventListener?: (event: "change", cb: () => void) => void;
  removeEventListener?: (event: "change", cb: () => void) => void;
}

interface NavigatorWithConnection {
  onLine?: boolean;
  connection?: NetworkInformationLike;
  mozConnection?: NetworkInformationLike;
  webkitConnection?: NetworkInformationLike;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: "M-NETWORK-DETECT",
    requirement: "UC-003",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_RESOLVE_CONNECTION
function getNavigator(): NavigatorWithConnection | null {
  if (typeof navigator === "undefined") return null;
  return navigator as unknown as NavigatorWithConnection;
}

function pickConnectionInfo(
  nav: NavigatorWithConnection,
): NetworkInformationLike | null {
  return (
    nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null
  );
}

function normalizeType(raw: string | undefined, online: boolean): ConnectionType {
  if (!online) return "none";
  if (!raw) return "unknown";
  const lower = raw.toLowerCase();
  if (lower === "wifi") return "wifi";
  if (lower === "cellular" || lower === "2g" || lower === "3g" || lower === "4g" || lower === "5g") {
    return "cellular";
  }
  if (lower === "none") return "none";
  return "unknown";
}
// END_BLOCK_RESOLVE_CONNECTION

// START_CONTRACT: getConnection
// PURPOSE: snapshot the current network state
// INPUTS: none
// OUTPUTS: Connection { type, online, effectiveType? }
// SIDE_EFFECTS: emits NETWORK_STATE log event
// LINKS: UC-003, V-M-NETWORK-DETECT
// END_CONTRACT: getConnection
export function getConnection(): Connection {
  if (cachedConnection) return cachedConnection;

  const nav = getNavigator();
  if (!nav) {
    cachedConnection = { type: "unknown", online: false };
    logInfo("getConnection", "NETWORK_STATE", "no navigator (non-browser env)", {
      ...cachedConnection,
    });
    return cachedConnection;
  }

  const online = nav.onLine !== false;
  const info = pickConnectionInfo(nav);
  const type = normalizeType(info?.type, online);
  const result: Connection = { type, online };
  if (info?.effectiveType) {
    result.effectiveType = info.effectiveType;
  }
  cachedConnection = result;
  logInfo(
    "getConnection",
    "NETWORK_STATE",
    "snapshot from navigator.connection",
    { ...result },
  );
  return result;
}

// START_CONTRACT: onConnectionChange
// PURPOSE: subscribe to navigator.connection change events
// INPUTS: cb: (conn: Connection) => void — called whenever the connection changes
// OUTPUTS: UnsubscribeFn — call to stop listening
// SIDE_EFFECTS: registers/removes a navigator.connection event listener
// LINKS: UC-003, V-M-NETWORK-DETECT
// END_CONTRACT: onConnectionChange
export function onConnectionChange(cb: (conn: Connection) => void): UnsubscribeFn {
  const nav = getNavigator();
  const info = nav ? pickConnectionInfo(nav) : null;
  if (!info || typeof info.addEventListener !== "function") {
    return () => {};
  }
  const handler = () => {
    cachedConnection = null;
    cb(getConnection());
  };
  info.addEventListener("change", handler);
  return () => {
    if (typeof info.removeEventListener === "function") {
      info.removeEventListener("change", handler);
    }
  };
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 1
// END_CHANGE_SUMMARY
