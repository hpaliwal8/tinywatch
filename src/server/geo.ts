import type { RequestContext } from "../types";

/** Pull IP / country / city from Cloudflare and Vercel headers. */
export function extractContext(req: Request): RequestContext {
  const h = req.headers;
  const ip =
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined;

  const country = h.get("cf-ipcountry") ?? h.get("x-vercel-ip-country") ?? undefined;
  const rawCity = h.get("x-vercel-ip-city") ?? undefined;

  return {
    ip,
    country: country ?? undefined,
    city: rawCity ? decodeURIComponent(rawCity) : undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
}
