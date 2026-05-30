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
        .get(from, to) as { n: number };
      return row.n;
    },

    async getSessions({ from, to }: TimeRange) {
      const row = db
        .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM tw_events WHERE ts BETWEEN ? AND ?`)
        .get(from, to) as { n: number };
      return row.n;
    },

    async getSectionDwell({ from, to }: TimeRange): Promise<SectionDwell[]> {
      return db
        .prepare(`
          SELECT json_extract(props, '$.section') AS section,
                 SUM(json_extract(props, '$.dwellMs')) AS totalMs,
                 COUNT(*) AS views
          FROM tw_events
          WHERE name = '$section' AND ts BETWEEN ? AND ?
          GROUP BY section
          ORDER BY totalMs DESC
        `)
        .all(from, to) as SectionDwell[];
    },

    async getTopCountries({ from, to }: TimeRange): Promise<CountryCount[]> {
      return db
        .prepare(`
          SELECT country, COUNT(DISTINCT anonymous_id) AS visitors
          FROM tw_events
          WHERE country IS NOT NULL AND ts BETWEEN ? AND ?
          GROUP BY country
          ORDER BY visitors DESC
          LIMIT 20
        `)
        .all(from, to) as CountryCount[];
    },

    async pruneBefore(before: number) {
      return db.prepare(`DELETE FROM tw_events WHERE ts < ?`).run(before).changes;
    },
  };
}
