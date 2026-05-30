import Database from "better-sqlite3";
import { sqliteAdapter } from "tinywatch/server";

export default {
  adapter: sqliteAdapter(new Database("analytics.db")),
};
