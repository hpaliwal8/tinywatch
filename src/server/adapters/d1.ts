import type {
  CountryCount,
  DbAdapter,
  SectionDwell,
  StoredEvent,
  TimeRange,
} from "../../types";
import type { D1Database } from "@cloudflare/workers-types";

// D1 is a Workers binding, not an npm dependency — the user passes `env.DB`.
// Same SQLite dialect as adapters/sqlite.ts, so positional `?` placeholders and
// the same SQL; the differences are the async surface (prepare().bind().run())
// and db.batch([...]) for the atomic insert transaction.

/** Number columns may arrive as bigint/string depending on driver — coerce. */
function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

/** Pass a D1 binding from your Worker env, e.g. `d1Adapter(env.DB)`. */
export function d1Adapter(db: D1Database): DbAdapter {
  return {
    async migrate() {
      // batch() runs the statements as a single implicit transaction.
      await db.batch([
        db.prepare(`
          CREATE TABLE IF NOT EXISTS tw_events (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            anonymous_id TEXT NOT NULL,
            user_id      TEXT,
            session_id   TEXT NOT NULL,
            path         TEXT,
            props        TEXT,
            country      TEXT,
            city         TEXT,
            user_agent   TEXT,
            ts           INTEGER NOT NULL,
            received_at  INTEGER NOT NULL
          )
        `),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tw_events_ts      ON tw_events(ts)`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tw_events_name    ON tw_events(name)`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tw_events_session ON tw_events(session_id)`),
      ]);
    },

    async insertEvents(events: StoredEvent[]) {
      if (events.length === 0) return;
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO tw_events
          (id, name, anonymous_id, user_id, session_id, path, props, country, city, user_agent, ts, received_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // One bound statement per event, run as a single atomic batch.
      await db.batch(
        events.map((e) =>
          stmt.bind(
            e.id,
            e.name,
            e.anonymousId,
            e.userId ?? null,
            e.sessionId,
            e.path ?? null,
            e.props ? JSON.stringify(e.props) : null,
            e.country ?? null,
            e.city ?? null,
            e.userAgent ?? null,
            e.ts,
            e.receivedAt,
          ),
        ),
      );
    },

    async getVisitors({ from, to }: TimeRange) {
      const rs = await db
        .prepare(`SELECT COUNT(DISTINCT anonymous_id) AS n FROM tw_events WHERE ts BETWEEN ? AND ?`)
        .bind(from, to)
        .all<{ n: number }>();
      return num(rs.results[0]?.n);
    },

    async getSessions({ from, to }: TimeRange) {
      const rs = await db
        .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM tw_events WHERE ts BETWEEN ? AND ?`)
        .bind(from, to)
        .all<{ n: number }>();
      return num(rs.results[0]?.n);
    },

    async getSectionDwell({ from, to }: TimeRange): Promise<SectionDwell[]> {
      const rs = await db
        .prepare(`
          SELECT json_extract(props, '$.section') AS section,
                 COALESCE(SUM(json_extract(props, '$.dwellMs')), 0) AS totalMs,
                 COUNT(*) AS views
          FROM tw_events
          WHERE name = '$section'
            AND json_extract(props, '$.section') IS NOT NULL
            AND ts BETWEEN ? AND ?
          GROUP BY section
          ORDER BY totalMs DESC
        `)
        .bind(from, to)
        .all<{ section: unknown; totalMs: unknown; views: unknown }>();
      // Project explicitly (mirrors the sqlite/turso adapters) so all backends
      // coerce identically — e.g. a numeric section value comes back as a string.
      return rs.results.map((r) => ({
        section: String(r.section),
        totalMs: num(r.totalMs),
        views: num(r.views),
      }));
    },

    async getTopCountries({ from, to }: TimeRange): Promise<CountryCount[]> {
      const rs = await db
        .prepare(`
          SELECT country, COUNT(DISTINCT anonymous_id) AS visitors
          FROM tw_events
          WHERE country IS NOT NULL AND ts BETWEEN ? AND ?
          GROUP BY country
          ORDER BY visitors DESC
          LIMIT 20
        `)
        .bind(from, to)
        .all<{ country: unknown; visitors: unknown }>();
      return rs.results.map((r) => ({
        country: String(r.country),
        visitors: num(r.visitors),
      }));
    },

    async pruneBefore(before: number) {
      const rs = await db.prepare(`DELETE FROM tw_events WHERE ts < ?`).bind(before).run();
      return num(rs.meta.changes);
    },
  };
}
