import { describe, expect, it } from "vitest";
import { extractContext } from "../src/server/geo";

describe("extractContext", () => {
  it("prefers Cloudflare IP + country headers", () => {
    const req = new Request("https://x.test", {
      headers: { "cf-connecting-ip": "1.2.3.4", "cf-ipcountry": "US" },
    });
    const ctx = extractContext(req);
    expect(ctx.ip).toBe("1.2.3.4");
    expect(ctx.country).toBe("US");
  });

  it("falls back to the first x-forwarded-for entry", () => {
    const req = new Request("https://x.test", {
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    });
    expect(extractContext(req).ip).toBe("9.9.9.9");
  });
});
