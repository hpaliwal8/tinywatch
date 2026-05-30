// Runtime-free type contracts shared by client + server.
// Consumers import these via `tinywatch/types`. Prefer `import type`.

/** A single event as it travels over the wire (client → server). */
export interface TinywatchEvent {
  /** Event name. Reserved: "$pageview", "$click", "$scroll", "$section". */
  name: string;
  /** Stable first-party anonymous id (cookieless). */
  anonymousId: string;
  /** Known user id, set after identify(). */
  userId?: string;
  /** Session id, rotated after inactivity. */
  sessionId: string;
  /** URL path at event time. */
  path: string;
  /** Arbitrary event properties. */
  props?: Record<string, unknown>;
  /** Client timestamp (ms since epoch). */
  ts: number;
}

/** Batch envelope POSTed to the ingestion handler. */
export interface EventBatch {
  events: TinywatchEvent[];
  /** SDK version, for spotting schema drift. */
  v: string;
}

/** Configuration passed to the client init(). */
export interface ClientConfig {
  /** Ingestion endpoint where your createHandler() is mounted. */
  endpoint: string;
  /** Click/pageview/scroll/section autocapture. Default true. */
  autocapture?: boolean;
  /** Flush interval (ms). Default 5000. */
  flushInterval?: number;
  /** Buffered events before an eager flush. Default 30. */
  batchSize?: number;
  /** Attribute used for click autocapture. Default "data-tw-track". */
  trackAttribute?: string;
  /** Attribute used for section dwell. Default "data-tw-section". */
  sectionAttribute?: string;
  /** Keep the anon id in memory only (no localStorage). Default false. */
  noPersist?: boolean;
}

/** A client plugin registered via use(). */
export interface Plugin {
  name: string;
  setup(ctx: PluginContext): void;
}

export interface PluginContext {
  track: (name: string, props?: Record<string, unknown>) => void;
  /** A read-only copy of the resolved config (mutating it does not affect the client). */
  config: Readonly<Required<ClientConfig>>;
}

/** Geo/IP info extracted server-side from platform headers. */
export interface RequestContext {
  ip?: string;
  country?: string;
  city?: string;
  userAgent?: string;
}

/** Normalized row the adapter persists. */
export interface StoredEvent extends TinywatchEvent {
  id: string;
  country?: string;
  city?: string;
  userAgent?: string;
  receivedAt: number;
}

export interface TimeRange {
  from: number;
  to: number;
}

export interface SectionDwell {
  section: string;
  totalMs: number;
  views: number;
}

export interface CountryCount {
  country: string;
  visitors: number;
}

/** Pluggable database adapter contract — implement one per backend. */
export interface DbAdapter {
  /** Create tables/indexes if absent. Called by `npx tinywatch migrate`. */
  migrate(): Promise<void>;
  /** Persist a batch of events. */
  insertEvents(events: StoredEvent[]): Promise<void>;
  getVisitors(range: TimeRange): Promise<number>;
  getSessions(range: TimeRange): Promise<number>;
  getSectionDwell(range: TimeRange): Promise<SectionDwell[]>;
  getTopCountries(range: TimeRange): Promise<CountryCount[]>;
  /** Delete raw events older than `before` (ms epoch). For the rollup helper. */
  pruneBefore?(before: number): Promise<number>;
}

export interface HandlerConfig {
  adapter: DbAdapter;
  /** Requests per IP per minute. Default 120. */
  rateLimit?: number;
  /** Allowed CORS origin(s). Default "*". */
  cors?: string | string[];
}

export interface QueriesConfig {
  adapter: DbAdapter;
}
