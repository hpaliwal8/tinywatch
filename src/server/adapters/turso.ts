import type {
  CountryCount,
  DbAdapter,
  SectionDwell,
  StoredEvent,
  TimeRange,
} from "../../types";
import type { Client, InValue } from "@libsql/client";

// libsql is SQLite under the hood, so the SQL is identical to adapters/sqlite.ts.
// The differences are all in the client surface: every call is async, statements
// take named `:name` args, the insert runs via client.batch([...], "write"), and
// aggregate results can come back as bigint (coerced to number below).

/** Number columns may arrive as bigint from libsql — coerce to a JS number. */
function num(v: InValue | undefined): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

/** Pass an @libsql/client Client (createClient({ url, authToken })). */
export function tursoAdapter(client: Client): DbAdapter {
  return {
    async migrate() {
      // execute() runs a single statement; split the DDL into a batch.
      await client.batch(
        [
          `CREATE TABLE IF NOT EXISTS tw_events (
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
          )`,
          `CREATE INDEX IF NOT EXISTS idx_tw_events_ts      ON tw_events(ts)`,
          `CREATE INDEX IF NOT EXISTS idx_tw_events_name    ON tw_events(name)`,
          `CREATE INDEX IF NOT EXISTS idx_tw_events_session ON tw_events(session_id)`,
        ],
        "write",
      );
    },

    async insertEvents(events: StoredEvent[]) {
      if (events.length === 0) return;
      // One INSERT per event, run as a single write transaction via batch().
      const sql = `
        INSERT OR IGNORE INTO tw_events
          (id, name, anonymous_id, user_id, session_id, path, props, country, city, user_agent, ts, received_at)
        VALUES
          (:id, :name, :anonymousId, :userId, :sessionId, :path, :props, :country, :city, :userAgent, :ts, :receivedAt)
      `;
      await client.batch(
        events.map((e) => ({
          sql,
          args: {
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
          } satisfies Record<string, InValue>,
        })),
        "write",
      );
    },

    async getVisitors({ from, to }: TimeRange) {
      const rs = await client.execute({
        sql: `SELECT COUNT(DISTINCT anonymous_id) AS n FROM tw_events WHERE ts BETWEEN :from AND :to`,
        args: { from, to },
      });
      return num(rs.rows[0]?.n);
    },

    async getSessions({ from, to }: TimeRange) {
      const rs = await client.execute({
        sql: `SELECT COUNT(DISTINCT session_id) AS n FROM tw_events WHERE ts BETWEEN :from AND :to`,
        args: { from, to },
      });
      return num(rs.rows[0]?.n);
    },

    async getSectionDwell({ from, to }: TimeRange): Promise<SectionDwell[]> {
      const rs = await client.execute({
        sql: `
          SELECT json_extract(props, '$.section') AS section,
                 COALESCE(SUM(json_extract(props, '$.dwellMs')), 0) AS totalMs,
                 COUNT(*) AS views
          FROM tw_events
          WHERE name = '$section'
            AND json_extract(props, '$.section') IS NOT NULL
            AND ts BETWEEN :from AND :to
          GROUP BY section
          ORDER BY totalMs DESC
        `,
        args: { from, to },
      });
      return rs.rows.map((r) => ({
        section: String(r.section),
        totalMs: num(r.totalMs),
        views: num(r.views),
      }));
    },

    async getTopCountries({ from, to }: TimeRange): Promise<CountryCount[]> {
      const rs = await client.execute({
        sql: `
          SELECT country, COUNT(DISTINCT anonymous_id) AS visitors
          FROM tw_events
          WHERE country IS NOT NULL AND ts BETWEEN :from AND :to
          GROUP BY country
          ORDER BY visitors DESC
          LIMIT 20
        `,
        args: { from, to },
      });
      return rs.rows.map((r) => ({
        country: String(r.country),
        visitors: num(r.visitors),
      }));
    },

    async pruneBefore(before: number) {
      const rs = await client.execute({
        sql: `DELETE FROM tw_events WHERE ts < :before`,
        args: { before },
      });
      return rs.rowsAffected;
    },
  };
}
