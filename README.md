# radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bjh33396fan-hash/radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bjh33396fan-hash/radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar: every DeFi protocol in the snapshot with no token on record, ranked by an implied token value.
The value model is fitted on the snapshot's own live tokens (log10 market cap on TVL, 7-day change, days tracked
and a shrunk sector effect), every term is tested blind (10-fold and walk-forward by listing date), each row carries
an 80% conformal band, token-launch odds come from sector peers, and every protocol gets a costed farm plan with a verdict.
The page recomputes each value with the same `dashboard/model.js` that main.ts used.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

Node 22, standard library only. Writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
