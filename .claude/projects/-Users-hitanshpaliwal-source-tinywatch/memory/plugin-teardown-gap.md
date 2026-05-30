---
name: plugin-teardown-gap
description: tinywatch Plugin contract has no teardown, so plugin listeners survive shutdown() and re-stack on re-init
metadata:
  type: project
---

The `Plugin` contract (`setup(ctx): void`) has **no teardown return**, so a plugin that registers listeners (e.g. `tinywatch/plugins/outbound` adds a document click listener) is NOT cleaned up by `shutdown()`. After `init→use(plugin)→shutdown→init→use(plugin)`, the plugin's listeners stack/duplicate — the same class of bug we fixed for autocapture/sections (which now return teardown via AbortController).

**Why:** discovered 2026-05-30 while building the first plugin (outbound). `shutdown()` tears down core + transport + autocapture, but plugins are opaque after `setup()` runs.

**How to apply (when fixing):** change `Plugin.setup` to optionally return a `Teardown` (`() => void`), have `use()` collect returned teardowns, and have `shutdown()` call them. This is a public-contract change to `PluginContext`/`Plugin` — settle it alongside the retry plugin's flush-failure hook (also a deferred contract extension — see notes), since both touch the same surface. Until then, plugins are safe for the common single-init case but not for re-init cycles. Relates to [[plugin-packaging-decision]].
