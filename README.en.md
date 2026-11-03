# Chaos

[![CI](https://github.com/sky-mirrors/dsh-chaos-memory/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/sky-mirrors/dsh-chaos-memory/actions/workflows/ci.yml)

Memory kernel for human–AI companionship. A **DeepSeek Harness plugin** (Cordis contract, `dsh-plugin`), Apache-2.0.

[中文](README.md)

It is not about storing things — it is about recalling the right thing at the right moment. So she brings up the promise she has not kept yet, and asks when she is unsure, instead of confidently being wrong.

## Data flow

The automatic channels are the main path; the tools are optional entry points:

```
Conversation text
  ↓ Trigger   session/event (user/message) — every turn, no tool call needed
  ↓ Extract   rules (zero-cost fallback, synchronous) → then async LLM (host ctx.llm, session route)
  ↓ Write     gate → quote gate → value-support gate → merge algebra → bitemporal
  ↓ Store     event (source of truth, append-only, one per sentence) + claim (derived view)
  ↓ Assemble  BM25 + potential Φ; two modes depending on whether the query points anywhere
  ↓ Inject    system-prompt/assemble inserts a <chaos> block, hard budget 200 chars
```

`chaos_write` / `chaos_recall` remain available for explicit writes and lookups, but memory no longer depends on the model remembering to call them.

---

## Status

### Measured in this session

| Item | Result | Evidence |
|---|---|---|
| Unit tests | **83 / 83 passing** | `node --test tests/*.test.js` |
| Plugin contract | **23 / 23 passing** (`name`/`inject`/`apply` + 5 tools + end-to-end + auto write/inject + unanswered questions + retract + host LLM wiring + db path + event dedupe + per-db turn + restart clock + session budget) | `tests/plugin.test.js` K1–K23 |
| Database path | one database per session `header.cwd`; different cwds are isolated | K16 |
| Event dedupe | auto channel + `chaos_write` on the same sentence → one event, `duplicate` | K17 |
| Per-db turn | session A's seq=100 does not shift session B's `valid_from` | K18 |
| Host assembly | `chaos` sits in the web profile tree alongside `llm` and `dsh-session` | `dsh --profile web --dump-config` |
| Tools visible in the UI | **verified** (called `chaos_status` in a real session) | user confirmation |
| Concurrent writes | 4 processes × 100 rows into one db → **400/400 stored, all ids unique** | multi-process probe (one-off, removed) |
| Ids never reused | still writable after a row was deleted | `tests/store.test.js` C8 |
| Session budget | injection pauses with a gap hint once the window's cap is spent; **resumes when the 8-turn window rolls over**; injected entries yield | `tests/plugin.test.js` K19 / `potential.test.js` P8 |
| Restart clock | after a process restart the turn clock resumes from the db's latest turn; a seq=1 revision in a new session still outranks the old value | `tests/plugin.test.js` K20 |
| Unanswered questions | user asks and the AI does not really answer → a `question` claim is written when `assistant/message` arrives | K21 / K22 |
| Retract | `chaos_retract` sets `state=retracted`, closes `tx_to`; never injected or turned into a thread again | K23 / C9 |
| Assembly log | every injection writes `assembly_log` (claim_id / score / reason / packet_hash) | `tests/potential.test.js` P9 |
| unspoken (rule-based) | training set 12/12, **holdout 0/10** | `scripts/unspoken-bench.js` |

### Historical (not re-run in this session)

| Item | Result | Evidence |
|---|---|---|
| Bulk ingest | 240,500 rows / 437 ms | `scripts/verify-all.js` |
| Retrieval latency | P50 0.28 ms / P95 0.49 ms | 200 assemble runs |
| Injection budget | max 200 chars, 0/10 over budget | budget=200 |
| Potential emergence | promise ranks first under small talk | `verify-all.js` §4 |
| Assembly determinism | three identical runs | `verify-all.js` §5 |
| Bitemporal | old value's `tx_to` closed after a revision | 3 cases (Hangzhou→Chengdu etc.) |
| Rule extraction | 18/18 facts | `scripts/ingest.js` |
| LLM extraction (real calls) | 18 calls, 0 failures, 100% format compliance | `scripts/e2e.js` (needs `DEEPSEEK_API_KEY`) |
| End-to-end recall | 8/8 (7 at rank 1) | `scripts/e2e.js` |

Note: `scripts/verify-all.js` could not run after `c44dc8c` (nested transaction in `ingestClaim`); it is fixed now. Re-run on 2026-11-03: ingest 1,042 ms, retrieval P50 0.33 ms / P95 0.74 ms, injection max 200 chars / 0 over budget, states `{"active":24,"deferred":3}`.

### Not verified

| Item | Missing |
|---|---|
| Real session event stream | needs one real session observing `session/event` and `system-prompt/assemble`; no credentials on this machine |
| LLM extraction under the real host | unit tests use a fake `ctx.llm`; `dsh headless` stops at `MISSING_CREDENTIAL` here |
| LLM holdout score for unspoken | needs `DEEPSEEK_API_KEY`; only the pipeline is verified (10/10 with ideal judgments) |
| Full LLM cost | 18 calls took 114 s; linear extrapolation ≈ 25 h for 240k rows |

---

## Quick start

### Requirements

**Node.js ≥ 24.** The storage layer uses the built-in `node:sqlite` `DatabaseSync`: the module does not exist before Node 22.5, and 22.x requires launching the host with `--experimental-sqlite` — a plugin cannot control the host's launch flags, so that is out of scope. The same constraint is declared in `package.json` `engines`.

### Install into dsh

```bash
# 1) Install from the git source into the target profile (web / desktop)
#    Not published to npm yet — this installs the repository source.
dsh plugin --profile web add git+https://github.com/sky-mirrors/dsh-chaos-memory.git

# 2) Add the package name to bundles by hand.
#    `dsh plugin add` only writes dependencies, not dsh.profile.bundles;
#    skip this and the plugin installs but never loads.
#    Edit ~/.dsh/profiles/web/package.json and append "dsh-chaos-memory"
#    to dsh.profile.bundles.

# 3) Confirm it entered the config tree
dsh --profile web --dump-config | grep -A1 chaos
```

For development, point at a local checkout instead: `dsh plugin --profile web add /path/to/chaos`.

Three traps, all hit before:

| Symptom | Cause |
|---|---|
| Installs but does nothing, no error | missing `dsh.bundle.patch` → it is a plain dependency, not a profile layer |
| Installs but does nothing, no error | package name missing from `bundles` → loader never loads it |
| Startup error `does not provide an export named ...` | dependency version mismatch with the host → reinstall against the host version |

### Two automatic channels

Nothing to configure:

- **Write** — `session/event` sees a `user/message` → rule-based extraction is written synchronously → the host LLM is called in the background for semantic items (failure degrades to the rule-based result). Deduped by `session.id:event.seq`.
- **Inject** — on `system-prompt/assemble` the memories that should surface are folded into the context; an empty query means emergence mode (Φ ordering).

### Tools (optional)

```js
// 1) Write: usually the auto channel already recorded this turn;
//    use the tool to add a specific slot or a kind.
await chaos_write({
  slot: 'promise.bookstore',
  value: '陪你看店铺',
  quote: '说好了陪你看店铺',
  source_text: '说好了陪你看店铺',
  kind: 'commitment',
})

// 2) Recall: returns a <chaos> block ready for injection
await chaos_recall({ query: '我那只猫叫什么' })

// 3) Correction: lowers the AI-side fidelity only
await chaos_correct({ id: 'c00001', penalty: 0.25 })

// 4) Retract: a bad extraction, or a promise that has been kept
await chaos_retract({ id: 'c00001' })
```

When `chaos_write` omits `turn`, it reuses the latest turn in the database — so it lands on the same event as the auto channel.

### Two layers of LLM extraction

`src/extract-llm.js` is the pure layer: it only accepts an injected `callModel`, and never imports a model SDK, reads environment variables, or makes network requests.

```js
import { extractLLM } from './src/extract-llm.js'

const cands = await extractLLM(text, {
  slots: ['user.pet.name', 'user.job', /* ... */],
  callModel: async (prompt) => {
    const r = await client.chat.completions.create({ model: 'deepseek-flash', messages: [...] })
    return r.choices[0].message.content
  },
})
```

The plugin entry (`index.js`) injects the host's `ctx.llm`: the route comes from `session.requestHeader().config` and the stream is collected with `BlockAssembler`. Credentials stay on the host side — the plugin never reads, stores, or forwards them. Before a session's first request there is no route, so that turn is rule-based only.

---

## Three paths

### Extraction: what the model said is not what gets stored

```
Model output (raw)
  ↓ ① slot must be in the allowlist      ← no invented slots
  ↓ ② quote must appear verbatim          ← no forged evidence
  ↓ ③ value must be supported by quote    ← no distorted values
candidate {slot, value, quote, kind}
```

Historical record (not re-run): in a 3,000-sample adversarial run, 750/750 legitimate outputs passed and forged quotes / wrong values / invented slots were each blocked 750/750.

The model can also emit a second kind of item: `{"kind":"unspoken","quote":"..."}` — it only answers "does this sentence contain something left unsaid". Such an item passes **only gate ②**: the slot is derived locally from a hash of the source text (`unspoken.<hash>`, the same address the rule-based extractor uses, so one sentence never becomes two claims) and the value is the whole sentence. The model decides "whether", never "what", so it cannot pollute the store by inventing. The rule-based `UNSPOKEN_RE` stays as the zero-cost fallback.

### Write: three gates, in exactly one place

```
source_text + quote
  ↓ gate            size ≤ 8000 / no U+FFFD / no control chars / no 3 identical lines / no secret pattern
  ↓ quote gate      quote must appear verbatim inside some event payload
  ↓ support gate    character-bigram coverage of value by quote ≥ 0.8
  ↓ merge algebra   same-slot conflicts ordered by (source priority, confidence, time); ties → deferred
claim (active / superseded / deferred / retracted)
```

A secret pattern means **the write is rejected, not redacted** — redaction would let users believe the key had been handled.

### Read: two modes

```
Φ = [a·R + (1−R)·(g·U + e·S)] · faith
faith = 0.5 + 0.5 · fidelity_ai
```

- `R` situational resonance (normalized BM25)
- `U` unresolved pressure (commitment threads, saturating with age)
- `S` rarity bonus (long unseen things are worth more when they surface)
- `faith` discounts the AI side only — a user's fuzzy memory should not make a claim disappear

**max R ≥ 0.2 → retrieval mode** (sorted by R); **otherwise → emergence mode** (sorted by Φ). Automatic injection uses the latter.

Historical record (not re-run): asking "今天好累" surfaced "三月十七那天我一整晚都陪着你，说好了" first.

---

## Design trade-offs

**Truth is the event, not the memory.** `event` is append-only and stores raw text; `claim` is a rebuildable derived view. Storage doubles, but every memory traces back to the original sentence, a broken database can be replayed, and a bad extraction can be retracted without poisoning history.

**One event per sentence.** Both the auto channel and `chaos_write` may record the same turn, so both go through `ensureEvent(db, ts, payload)` and reuse the existing id on a hit. Otherwise one fact would carry two pieces of evidence and the merge algebra would treat it as corroboration, inflating confidence for free. Repeating the same sentence in a later turn still corroborates — that is genuine corroboration, not duplication.

**Turn is a per-database timeline.** The clock is kept per database (`<cwd>/.rivet/chaos/chaos.db`); sharing one counter lets one session's high seq push another session's `valid_from` into the future.

**No vector database.** A single user's memory is a few hundred rows; BM25 (Chinese unigrams + bigrams + IDF) is enough — zero dependencies, explainable, and it keeps working when an embedding service does not.

**Silence when unsure.** Irreconcilable same-slot conflicts become `deferred` and are not injected. Better to say one thing less than one thing wrong.

**The model is external input.** Every extracted item passes three gates; even a completely fabricated output cannot pollute the store.

**Gates run once, at the entrance.** All validation lives on the single boundary in `ingestClaim`; inner functions trust the result.

**Bulk writes need a transaction.** 240k raw inserts take 266 s (fsync per row); inside `BEGIN/COMMIT` it takes 437 ms — a 608× difference. This defect is invisible on `:memory:`.

---

## Layout

```
chaos/
  index.js            plugin entry: Cordis apply(ctx), two automatic channels, 5 tools
  cordis.patch.yml    bundle patch: inserts the chaos row into the profile config tree
  package.json        dsh.bundle.patch points at the file above; dependency versions must match the host
  src/
    constants.js      thresholds (single source)
    db.js             SQLite schema: event / claim / assembly_log + migrations
    gate.js           write gate: size / encoding / secrets
    store.js          bitemporal store: quote gate + support gate + merge algebra + four states + ensureEvent / latestTurn
    retrieval.js      BM25 (Chinese unigrams + bigrams + IDF)
    potential.js      thread derivation + Φ + two-mode assembly
    fidelity.js       decay / divergence / negotiation wording / revision chains
    extract.js        rule-based extractor (pattern table + SLOTS allowlist, zero-cost baseline)
    extract-llm.js    LLM extractor (three gates over model output; includes the unspoken item)
  tests/              77 cases, 8 files
  scripts/
    ingest.js         ingest real dialogue + statistics
    llm-probe.js      real-model extraction probe (empty replies / recall / false positives)
    e2e.js            end-to-end: extract → store → natural-question recall
    verify-all.js     six system checks (performance / budget / emergence / determinism / bitemporal)
    unspoken-bench.js unspoken benchmark (training + holdout; `--llm` uses the LLM item)
```

---

## Data

`<session cwd>/.rivet/chaos/chaos.db` (SQLite, WAL). The database follows the session's working directory, not the process start directory — different workspaces in one process get separate databases.

Tables: `event` (source of truth, append-only), `claim` (bitemporal view), `assembly_log`, `schema_migrations`.

---

## Verification

```bash
node --test tests/*.test.js                    # 83 unit tests
node scripts/verify-all.js                     # six system checks, no external dependencies
node scripts/unspoken-bench.js                 # unspoken, rule-based: training / holdout
DEEPSEEK_API_KEY=... node scripts/unspoken-bench.js --llm   # unspoken, LLM version
DEEPSEEK_API_KEY=... node scripts/e2e.js       # real-model end-to-end (costs tokens)
```

---

## License

Apache-2.0 © Chaos contributors
