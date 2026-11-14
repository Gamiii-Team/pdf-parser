# Fixtures

| File | Kind | Origin |
|---|---|---|
| `scanned.pdf` | image-only (scanned-style) PDF | rasterized from `test.pdf` at 150 dpi |
| `page-one.png` | image input | rasterized page 1 of `test.pdf` |
| `expected-manifest.json` | structural expectation | hand-verified offline run of `extractDocument('test.pdf', { figurePass: false, subjectDetect: false })`, with volatile keys (`id`, `bbox`, `source_file`) stripped |

Regenerate the scanned/image fixtures with:

```bash
node scripts/create-fixtures.mjs
```

`expected-manifest.json` is a regression fixture — if you intentionally change
the tree shape or block content, regenerate it the same way the test compares
(current `simp()` in `tests/expected.test.js`: recursively strip `id`, `bbox`,
`source_file`, then compare) and verify the diff by hand before committing.

The born-digital source fixture lives at the repo root as `test.pdf`.
