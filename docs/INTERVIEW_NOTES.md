# PixelBlame: interview notes

## 30-second pitch

PixelBlame is a debugging tool for apps that send photos to vision-language models. It answers two questions logs can't. First, *which part of the image caused this output item?* It occludes grid cells, calls the model, and uses delta debugging to find the minimal region whose removal makes an item disappear. Second, *how much can an image change before the answer changes?* It replays a request under JPEG, resize, blur, brightness, rotation and crop ladders, plots perceptual distance against output change, and uses that measurement to set the threshold of a near-duplicate cache. So the cache is calibrated, not guessed. Everything runs offline with a deterministic mock model and has 29 tests.

## The 5 hardest problems and how I solved them

1. **A near-match cache would corrupt the tools that use it.** Of 14 single-cell masks that removed an item across the demo photos, 6 were within dHash distance 1 of the unmasked image (2 at exactly 0), so even a threshold-1 near cache would answer "nothing changed" to blame masks that did change the output. Drift has the same problem: the cache would hide the drift being measured. *Solution:* cache policy is per client (`off | exact | calibrated`). Blame and Drift use exact-only, and only app traffic gets calibrated near matching.

2. **Choosing the near-match threshold without guessing.** *Solution:* `threshold = (largest distance below the first distance where any output changed) − margin`. The rule is conservative by construction: one change at a small distance pulls the threshold down for everyone. A change at distance 0, or no data, turns near matching off. Calibration is scoped to the model and request key it measured.

3. **Joint effects in attribution.** Single-cell occlusion misses objects that straddle cells: masking either half alone leaves enough of the yellow dress for the model to still see it. *Solution:* ddmin over all cells with test = "item absent". It found the 2-cell region in 8 extra calls. A memoized mask oracle plus the exact cache means ddmin's repeated subsets are free. On a synthetic 3-of-16 AND oracle, ddmin ran 70 tests but only 40 unique ones.

4. **Heatmaps that blamed innocent cells.** My first heatmap was a conditional average, P(lost | masked) − P(lost | not masked). It lit up cells that were only ever masked in the same ddmin chunk as the real cause. *Solution:* ridge regression of loss on cell-mask indicators over all tested masks (LIME-style), which separates co-occurring cells. The red shirt's heat went from "whole top row" to exactly cell 0.

5. **Recording must never break the app, and async writes create a race.** Writes are queued and drained on `setImmediate`, with errors routed to `onError`. Two bugs surfaced: (a) queued writes read the *current* run ID at flush time, so calls landed in the wrong run. Fixed by capturing it at enqueue time. (b) A back-to-back identical call could miss the cache before the write landed. Fixed with an in-memory pending map that's cleared after each drain. A test injects a store that throws on every write and checks that the call still returns.

## Likely interview questions

**Why dHash and not embeddings?** It's cheap (a 9×8 grayscale resize), deterministic, has no model dependency, and Hamming distance is easy to explain and threshold. The weakness is measured, not assumed: it's blind to blur and fragile under rotation and crop. That's exactly why the threshold comes from data and why the cache can turn itself off.

**Is a threshold of 1 useful?** Yes, for the most common case: the same photo re-uploaded, resized or re-compressed. That gave distance 0–1 in the demo, and exact matching misses all of it because the bytes differ. A bigger threshold would have served a wrong answer for a σ8 blur at distance 3.

**What does ddmin guarantee?** 1-minimality: removing any single cell from the returned set makes the test fail. It doesn't guarantee the globally smallest set. Worst case it's O(n²) tests, typically O(k log n) for k causes.

**How do you stop it from burning money?** A hard `--max-calls` budget on *live* calls (cache hits are free), a `--dry-run` estimate with cost, and graceful degradation: when the budget runs out, results are marked "not proven minimal" instead of failing. The demo stops at exactly 10 calls with `--max-calls 10`.

**Isn't occlusion biased?** Yes. A gray patch is itself content. I track masks where the fill introduced new items, offer a blur fill as a second opinion, and list it as a limitation.

**What about nondeterministic models?** With temperature > 0, the same image can change the output at distance 0. Calibration would then turn near matching off, which is correct. Future work: repeat each step to separate noise from drift.

**Why is the mock adapter designed like that?** So both features have real, checkable behavior offline: occluding a cell removes its item, heavy blur desaturates, rotation and crop move color across cells, mild JPEG and resize change nothing. I tuned its thresholds on measured cell shares until each perturbation family had a real tipping point.

**What would you do with more time?** Segmentation-based masks, adaptive grid refinement, a second perceptual hash, per-family calibration, and real-model validation.

## Resume bullets

- Built **PixelBlame**, a TypeScript/Node developer tool that attributes each item of a vision model's JSON output to image regions using black-box occlusion plus delta debugging (ddmin). It found a 2-cell joint cause invisible to single-cell tests and explained 5 items in 25 model calls under a 40-call budget, with **0 calls (26/26 cached)** on re-run.
- Designed a **calibrated near-duplicate cache** for image requests (SHA-256 exact match, then dHash near match). Its threshold is derived from Drift Map measurements across 6 perturbation families (56 points), so it served a 55%-smaller re-encoded photo from cache while correctly rejecting a heavy blur whose real output changed by 0.6.
- Shipped it end to end with **SQLite (better-sqlite3), Express, sharp and a canvas UI**, a deterministic mock VLM for offline demos, **29 Vitest tests** and GitHub Actions CI. Recording is async and fault-isolated: an injected write failure never breaks the app's call.
