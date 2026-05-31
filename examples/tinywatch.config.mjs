import Database from "better-sqlite3";
import { sqliteAdapter } from "@hitansh8/tinywatch/server";

export default {
  adapter: sqliteAdapter(new Database("analytics.db")),
};
