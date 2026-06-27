# Contributing

Contributions are welcome and appreciated ✨

## What to contribute

- **New dialect markers** — See `src/extract.ts`, add entries to the
  `DIALECT_MARKERS` array with locale, useWhen, avoidWhen, and notes.
- **New catchphrases / internet slang** — Add to `ZH_CATCHPHRASES`,
  `EN_CATCHPHRASES`, `ZH_INTERNET_SLANG`, or `EN_INTERNET_SLANG`.
- **Better sensitivity heuristics** — Improve `src/sensitivity.ts` to catch
  new credential or PII patterns.
- **Bug fixes, tests, docs** — Always welcome.

## Rules

- Add tests for new extraction rules in `src/extract.test.ts`.
- Run `npm run check && npm test` before pushing.
- Keep the dictionary additions pattern-consistent with existing entries.
- Dialect / slang entries must carry `useWhen` and `avoidWhen` context labels.

## Setup

```bash
git clone https://github.com/hexingyuofficial/style-memory-mcp.git
cd style-memory-mcp
npm install
npm run check
npm test
```
