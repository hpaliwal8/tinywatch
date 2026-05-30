import type { DbAdapter } from "../../types";
import type { Client } from "@libsql/client";

// The SQL is identical to adapters/sqlite.ts. The only difference is the async
// client surface: `await client.execute({ sql, args })` and `client.batch([...])`
// for the insert transaction. Port each method over.
export function tursoAdapter(_client: Client): DbAdapter {
  return unimplemented("turso");
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
