import type {
  CountryCount,
  DbAdapter,
  SectionDwell,
  StoredEvent,
  TimeRange,
} from "../../types";
import type { Pool } from "pg";

// Postgres is the one adapter with real dialect divergence from sqlite.ts:
//   • placeholders are $1, $2, ... (not ?)
//   • props is JSONB; JSON access is props->>'section' and
//     (props->>'dwellMs')::numeric (not json_extract)
//   • ts / received_at are BIGINT
//   • dedup is ON CONFLICT (id) DO NOTHING (not INSERT OR IGNORE)
// The query *shapes* still mirror sqlite.ts.

// pg returns BIGINT and COUNT(*) as strings (to avoid precision loss), so always
// coerce numeric reads. Values here are well within Number's safe range.
function num(v: unknown): number {
  return Number(v ?? 0);
}

const COLUMNS = 12; // columns per inserted row, for $-placeholder grouping
// Postgres caps a single statement at 65535 bind parameters (Int16 wire field).
// Chunk inserts well under that ceiling so the adapter is self-safe regardless
// of how many events a caller passes (the HTTP handler caps batches, but
// insertEvents is a public API others can call directly).
const MAX_ROWS_PER_INSERT = 5000; // 5000 * 12 = 60000 params, safely < 65535

/** Pass a node-postgres Pool you already own, e.g. `postgresAdapter(new Pool())`. */
export function postgresAdapter(pool: Pool): DbAdapter {
  return {
    async migrate() {
      // One statement per query() — clearer errors, and avoids drivers/poolers
      // that reject multiple statements in a single simple query.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tw_events (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          anonymous_id TEXT NOT NULL,
          user_id      TEXT,
          session_id   TEXT NOT NULL,
          path         TEXT,
          props        JSONB,
          country      TEXT,
          city         TEXT,
          user_agent   TEXT,
          ts           BIGINT NOT NULL,
          received_at  BIGINT NOT NULL
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_tw_events_ts      ON tw_events(ts)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_tw_events_name    ON tw_events(name)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_tw_events_session ON tw_events(session_id)`);
    },

    async insertEvents(events: StoredEvent[]) {
      if (events.length === 0) return;
      // Dedup by id within the batch (keep first), mirroring the per-row
      // INSERT OR IGNORE "first writer wins" of the SQLite-family adapters.
      // A single multi-row INSERT can't rely on ON CONFLICT to resolve
      // intra-statement duplicates, so resolve them here for provable parity.
      const seen = new Set<string>();
      const rows = events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));

      // Chunk to stay under Postgres's per-statement parameter ceiling. Each
      // chunk is one multi-row INSERT: atomic and a single round-trip.
      for (let start = 0; start < rows.length; start += MAX_ROWS_PER_INSERT) {
        const chunk = rows.slice(start, start + MAX_ROWS_PER_INSERT);
        const groups: string[] = [];
        const args: unknown[] = [];
        chunk.forEach((e, i) => {
          const b = i * COLUMNS;
          groups.push(
            `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12})`,
          );
          args.push(
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
          );
        });
        await pool.query(
          `INSERT INTO tw_events
             (id, name, anonymous_id, user_id, session_id, path, props, country, city, user_agent, ts, received_at)
           VALUES ${groups.join(", ")}
           ON CONFLICT (id) DO NOTHING`,
          args,
        );
      }
    },

    async getVisitors({ from, to }: TimeRange) {
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT anonymous_id) AS n FROM tw_events WHERE ts BETWEEN $1 AND $2`,
        [from, to],
      );
      return num(rows[0]?.n);
    },

    async getSessions({ from, to }: TimeRange) {
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT session_id) AS n FROM tw_events WHERE ts BETWEEN $1 AND $2`,
        [from, to],
      );
      return num(rows[0]?.n);
    },

    async getSectionDwell({ from, to }: TimeRange): Promise<SectionDwell[]> {
      const { rows } = await pool.query(
        // NOTE: a non-numeric string dwellMs (e.g. "100ms") makes ::numeric throw
        // on real Postgres, whereas the SQLite-family adapters silently coerce —
        // a known divergence (tracked) that only the real-PG CI parity job can
        // exercise, since pg-mem neither enforces numeric validation nor supports
        // the `~` / jsonb_typeof guards a fix would need. Autocapture only ever
        // emits a numeric dwellMs, so this is malformed-input-only.
        `SELECT props->>'section' AS section,
                COALESCE(SUM((props->>'dwellMs')::numeric), 0) AS "totalMs",
                COUNT(*) AS views
         FROM tw_events
         WHERE name = '$section'
           AND props->>'section' IS NOT NULL
           AND ts BETWEEN $1 AND $2
         GROUP BY props->>'section'
         ORDER BY "totalMs" DESC`,
        [from, to],
      );
      return rows.map((r) => ({
        section: String(r.section),
        totalMs: num(r.totalMs),
        views: num(r.views),
      }));
    },

    async getTopCountries({ from, to }: TimeRange): Promise<CountryCount[]> {
      const { rows } = await pool.query(
        `SELECT country, COUNT(DISTINCT anonymous_id) AS visitors
         FROM tw_events
         WHERE country IS NOT NULL AND ts BETWEEN $1 AND $2
         GROUP BY country
         ORDER BY visitors DESC
         LIMIT 20`,
        [from, to],
      );
      return rows.map((r) => ({
        country: String(r.country),
        visitors: num(r.visitors),
      }));
    },

    async pruneBefore(before: number) {
      const res = await pool.query(`DELETE FROM tw_events WHERE ts < $1`, [before]);
      return res.rowCount ?? 0;
    },
  };
}
