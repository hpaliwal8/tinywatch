import type { ClientConfig } from "../types";

const ANON_KEY = "tw_anon";
const SESSION_KEY = "tw_session";
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 min

let memAnon: string | undefined;
// In-memory fallback when sessionStorage is blocked (private mode, etc.).
let memSession: { id: string; last: number } | undefined;

function rid(): string {
  return crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** In-memory anon id: used when persistence is off or localStorage is blocked. */
function memId(): string {
  return (memAnon ??= rid());
}

export function getAnonymousId(persist: boolean): string {
  if (!persist) return memId();
  try {
    let id = localStorage.getItem(ANON_KEY);
    if (!id) {
      id = rid();
      localStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    // localStorage blocked (private mode, etc.) — fall back to memory.
    return memId();
  }
}

export function getSessionId(): string {
  const now = Date.now();

  // Persist in sessionStorage so the session survives page navigations within a
  // tab — otherwise every full page load mints a new id and inflates session
  // counts. Falls back to an in-memory record when storage is unavailable.
  let rec = readSession();
  if (rec && now - rec.last < SESSION_TIMEOUT) {
    rec.last = now;
  } else {
    rec = { id: rid(), last: now };
  }
  writeSession(rec);
  return rec.id;
}

function readSession(): { id: string; last: number } | undefined {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as { id: string; last: number }) : undefined;
  } catch {
    return memSession;
  }
}

function writeSession(rec: { id: string; last: number }): void {
  memSession = rec;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(rec));
  } catch {
    // sessionStorage blocked — memSession already holds the value.
  }
}

export type { ClientConfig };
