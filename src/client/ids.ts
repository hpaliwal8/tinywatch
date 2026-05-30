import type { ClientConfig } from "../types";

const ANON_KEY = "tw_anon";
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 min

let memAnon: string | undefined;
let session: { id: string; last: number } | undefined;

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
  if (session && now - session.last < SESSION_TIMEOUT) {
    session.last = now;
    return session.id;
  }
  session = { id: rid(), last: now };
  return session.id;
}

export type { ClientConfig };
