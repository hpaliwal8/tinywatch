import type {
  CountryCount,
  DbAdapter,
  SectionDwell,
  StoredEvent,
  TimeRange,
} from "../../types";
import type Database from "better-sqlite3";

/** Pass a better-sqlite3 Database instance you already own. */
export function sqliteAdapter(db: Database.Database): DbAdapter {
  return {
    async migrate() {
      db.exec(`
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
        );
        CREATE INDEX IF NOT EXISTS idx_tw_events_ts      ON tw_events(ts);
        CREATE INDEX IF NOT EXISTS idx_tw_events_name    ON tw_events(name);
        CREATE INDEX IF NOT EXISTS idx_tw_events_session ON tw_events(session_id);
      `);
    },

    async insertEvents(events: StoredEvent[]) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO tw_events
          (id, name, anonymous_id, user_id, session_id, path, props, country, city, user_agent, ts, received_at)
        VALUES
          (@id, @name, @anonymousId, @userId, @sessionId, @path, @props, @country, @city, @userAgent, @ts, @receivedAt)
      `);
      const tx = db.transaction((rows: StoredEvent[]) => {
        for (const e of rows) {
          stmt.run({
            id: e.id,
            name: e.name,
            anonymousId: e.anonymousId,
            userId: e.userId ?? null,
            sessionId: e.sessionId,
            path: e.path ?? null,
            props: e.props ? JSON.stringify(e.props) : null,
            country: e.country ?? null,
            city: e.city ?? null,
            userAgent: e.userAgent ?? null,
            ts: e.ts,
            receivedAt: e.receivedAt,
          });
        }
      });
      tx(events);
    },

    async getVisitors({ from, to }: TimeRange) {
      const row = db
        .prepare(`SELECT COUNT(DISTINCT anonymous_id) AS n FROM tw_events WHERE ts BETWEEN ? AND ?`)
        .get(from, to) as { n: number | bigint };
      return Number(row.n);
    },

    async getSessions({ from, to }: TimeRange) {
      const row = db
        .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM tw_events WHERE ts BETWEEN ? AND ?`)
        .get(from, to) as { n: number | bigint };
      return Number(row.n);
    },

    async getSectionDwell({ from, to }: TimeRange): Promise<SectionDwell[]> {
      const rows = db
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
        .all(from, to) as { section: unknown; totalMs: unknown; views: unknown }[];
      // Project explicitly (mirrors the turso adapter) so both backends coerce
      // identically — e.g. a numeric `data-tw-section` value comes back as a
      // string from both, and aggregates are always JS numbers even if the
      // caller's db has safeIntegers enabled.
      return rows.map((r) => ({
        section: String(r.section),
        totalMs: Number(r.totalMs),
        views: Number(r.views),
      }));
    },

    async getTopCountries({ from, to }: TimeRange): Promise<CountryCount[]> {
      const rows = db
        .prepare(`
          SELECT country, COUNT(DISTINCT anonymous_id) AS visitors
          FROM tw_events
          WHERE country IS NOT NULL AND ts BETWEEN ? AND ?
          GROUP BY country
          ORDER BY visitors DESC
          LIMIT 20
        `)
        .all(from, to) as { country: unknown; visitors: unknown }[];
      return rows.map((r) => ({
        country: String(r.country),
        visitors: Number(r.visitors),
      }));
    },

    async pruneBefore(before: number) {
      return Number(db.prepare(`DELETE FROM tw_events WHERE ts < ?`).run(before).changes);
    },
  };
}
