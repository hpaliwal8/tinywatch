import type { DbAdapter } from "../../types";
import type { Pool } from "pg";

// Postgres dialect differs from SQLite in two places:
//   • placeholders are $1, $2, ... (not ?)
//   • JSON access is props->>'section' / (props->>'dwellMs')::int (not json_extract)
//   • store `props` as JSONB and use BIGINT for ts/received_at
// Otherwise the query shapes match adapters/sqlite.ts.
export function postgresAdapter(_pool: Pool): DbAdapter {
  return unimplemented("postgres");
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
