# Self corpus: named top-level declarations only

`entityScanner.ts` is a byte-identical snapshot of local commit `f711a50d0ccdf87d220c4beeb548466f49cb7681`. Its local Git blob is verified; this is not a claim that the unpushed commit exists on GitHub. The package's Apache-2.0 license is retained.

The oracle uses TypeScript 5.9.3's compiler AST, independently of cxt/tree-sitter, with review of the printed declaration names and source boundaries. This is **compiler-assisted**, not a hand-authored or independently PR-reviewed oracle. It contains 50 named top-level declarations with syntactic export and value-parameter counts. The old issue's count of 49 refers to an older source revision.

Scoring considers every named declaration whose `scopedName` equals its name, excluding anonymous callback names. Nested declarations are outside this tier and cannot inflate its true-positive count. Missing top-level declarations still reduce recall and additional top-level declarations reduce precision. This own-code tier supplies no call, CFG, dataflow or rule oracle.

Labels and source were frozen before the first cxt evaluation (`bench/self-first-evaluation.json`); all six metrics were 1.0 over 50 declarations. The result measures this selected source inventory, not generalization. `bench:self` replays the gate against the frozen snapshot instead of whichever entityScanner.ts happens to be in the current working tree.
