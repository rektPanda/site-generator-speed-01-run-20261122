# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/rektPanda/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/rektPanda/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0: builds the same static site, byte for byte, in less CPU time. Front matter is scanned on the raw text (no split/join of the body), Markdown renders in a single pass, templates are compiled to plain JavaScript functions, and word counts, long dates and tag slugs are cached. No dependencies, Node stdlib only. No WebAssembly: the bounty rules allow JavaScript/TypeScript source only, so the speed comes from fused JS, not from a compiled binary.

## Run it

```sh
node main.ts
```

Reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`) and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=1e8h8xtg&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
