// Next.js App Router — a minimal server-rendered stats dashboard.
// Place at: app/dashboard/page.tsx
//
// "Bring your own dashboard": tinywatch gives you queries, not a UI. This reads
// straight from your DB via createQueries in a React Server Component.

import Database from "better-sqlite3";
import { createQueries, sqliteAdapter } from "@hitansh8/tinywatch/server";

const stats = createQueries({ adapter: sqliteAdapter(new Database("analytics.db")) });

export default async function DashboardPage() {
  // All queries default to the last 7 days; pass { from, to } (ms epoch) to scope.
  const [visitors, sessions, countries, dwell] = await Promise.all([
    stats.getVisitors(),
    stats.getSessions(),
    stats.getTopCountries(),
    stats.getSectionDwell(),
  ]);

  return (
    <main>
      <h1>Last 7 days</h1>
      <p>
        {visitors} visitors · {sessions} sessions
      </p>

      <h2>Top countries</h2>
      <ul>
        {countries.map((c) => (
          <li key={c.country}>
            {c.country}: {c.visitors}
          </li>
        ))}
      </ul>

      <h2>Section dwell</h2>
      <ul>
        {dwell.map((d) => (
          <li key={d.section}>
            {d.section}: {Math.round(d.totalMs / 1000)}s over {d.views} views
          </li>
        ))}
      </ul>
    </main>
  );
}
