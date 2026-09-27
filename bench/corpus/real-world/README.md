# Licensed source slices — first evaluation labels

The source bytes, licenses and hand-authored declaration labels were frozen before the first cxt evaluation. `provenance.json` pins package version, upstream location, original/slice/license SHA-256, slice line range and label SHA. These samples are selected utility code, not a random or independently reviewed benchmark. A source-code excerpt need not type-check in isolation; omitted imports/types are documented by its original location.

- Zod 4.3.6, `util.ts` lines 191–264: generic functions, callback scopes, a returned getter, primitive operations and a named constant. MIT, `ZOD-LICENSE.txt`.
- Ubuntu CPython 3.12.3-1ubuntu0.17, complete `Lib/fnmatch.py` lines 1–185: decorated helper, public functions, module constant and pattern translation. Complete distribution copyright/license notice in `PYTHON-COPYRIGHT.txt`.
- rust-fnv 1.0.7, `lib.rs` lines 1–136: struct, trait/inherent implementation methods and aliases. Upstream unit-test module omitted at the slice boundary. MIT alternative, `FNV-LICENSE.txt`.

Labels count syntactic declarations, including anonymous callbacks by source-coordinate name. TS/Rust export means syntactic `export`/`pub`; Python uses the leading-underscore convention. Trait visibility or runtime export reachability is a different fact. Parameter count includes receiver/self parameters, excludes generic type parameters and Python separator markers. Rust attributes remain separate sibling nodes and are excluded from function/type spans; Python decorators and TS export wrappers belong to the declaration span.

Do not overwrite the first evaluation when fixing defects. Retain its failures and distinguish a post-fix regression result from unseen evaluation. `engineEvaluated` records whether the labels were revised after seeing a result. These files are excluded from cxt's own product-source scan by `.cxtignore`; benchmark loaders read them explicitly.

The first evaluation passed every field except three Rust scopes. This was a labeling error: v1 omitted the trait qualifier from Default/Hasher methods. Rust's [canonical trait paths](https://doc.rust-lang.org/reference/paths.html#canonical-paths) and the pre-existing `rust/trait-impl` synthetic label distinguish `<Type as Trait>` from the inherent implementation. Original `expected.v1.json` and `bench/external-first-evaluation.json` are preserved; `label-revisions.json` records the exact three changes and hashes. The analyzer was unchanged. The corrected result is a label-reviewed regression result, not unseen performance.
