import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outbound } from "../src/plugins/outbound";
import type { PluginContext } from "../src/types";

// Stub the document click delegation + location so the plugin runs in node.

let clickHandler: ((e: unknown) => void) | undefined;

// Build a fake <a> element with a working closest("a") + getAttribute("href").
function fakeAnchor(href: string | null, text = "link") {
  const el = {
    getAttribute: (k: string) => (k === "href" ? href : null),
    textContent: text,
  };
  return { closest: (sel: string) => (sel === "a" ? el : null) };
}

function setup(opts?: Parameters<typeof outbound>[0]) {
  const track = vi.fn();
  const ctx = { track, config: {} as PluginContext["config"] };
  outbound(opts).setup(ctx);
  return { track, click: (target: unknown) => clickHandler?.({ target }) };
}

beforeEach(() => {
  clickHandler = undefined;
  vi.stubGlobal("location", { href: "https://mysite.com/page", host: "mysite.com" });
  vi.stubGlobal("document", {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === "click") clickHandler = fn;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("outbound plugin", () => {
  it("tracks a click to an external host", () => {
    const { track, click } = setup();
    click(fakeAnchor("https://external.com/x", "Visit"));
    expect(track).toHaveBeenCalledWith("$outbound", {
      href: "https://external.com/x",
      text: "Visit",
    });
  });

  it("ignores clicks to the same host", () => {
    const { track, click } = setup();
    click(fakeAnchor("/internal"));
    click(fakeAnchor("https://mysite.com/other"));
    expect(track).not.toHaveBeenCalled();
  });

  it("ignores non-http protocols and unresolvable hrefs", () => {
    const { track, click } = setup();
    click(fakeAnchor("mailto:a@b.com"));
    click(fakeAnchor("javascript:void 0"));
    click(fakeAnchor("#anchor"));
    click(fakeAnchor(null));
    expect(track).not.toHaveBeenCalled();
  });

  it("ignores clicks not on an anchor", () => {
    const { track, click } = setup();
    click({ closest: () => null });
    expect(track).not.toHaveBeenCalled();
  });

  it("respects a custom event name and internalHosts", () => {
    const { track, click } = setup({ eventName: "ext_click", internalHosts: ["docs.mysite.com"] });
    click(fakeAnchor("https://docs.mysite.com/guide")); // treated as internal
    click(fakeAnchor("https://external.com/y"));
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("ext_click", expect.objectContaining({ href: "https://external.com/y" }));
  });

  it("resolves relative protocol-less external links correctly", () => {
    const { track, click } = setup();
    click(fakeAnchor("//external.com/path"));
    expect(track).toHaveBeenCalledWith("$outbound", expect.objectContaining({
      href: "https://external.com/path",
    }));
  });

  it("is a no-op when document is undefined (non-browser)", () => {
    vi.stubGlobal("document", undefined);
    const track = vi.fn();
    expect(() => outbound().setup({ track, config: {} as PluginContext["config"] })).not.toThrow();
  });
});
