import type { DbAdapter } from "../../types";
import type { D1Database } from "@cloudflare/workers-types";

// D1 is a Workers binding, not an npm dependency — the user passes `env.DB`.
// Same SQLite dialect as adapters/sqlite.ts; use `db.prepare(sql).bind(...).run()`
// and `db.batch([...])` for inserts.
export function d1Adapter(_db: D1Database): DbAdapter {
  return unimplemented("d1");
}

function unimplemented(name: string): DbAdapter {
  const fail = () =>
    Promise.reject(
      new Error(`tinywatch: '${name}' adapter not implemented yet — port the SQL from adapters/sqlite.ts`),
    );
  return {
    migrate: fail,
    insertEvents: fail,
    getVisitors: fail,
    getSessions: fail,
    getSectionDwell: fail,
    getTopCountries: fail,
  };
}
