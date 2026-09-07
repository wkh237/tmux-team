# TypeScript runtime baseline

Owner: [#94](https://github.com/wkh237/tmux-team/issues/94), under the
[Rust rewrite decision](RUST-REWRITE.md). Production reference:
`cb53533f3a9f19a1a2ab95af59dda20df419200b`, version 5.0.0-alpha.1.
Only measurement tools/docs/governance differ from that reference in this PR;
`bin/`, `src/`, runtime dependencies and lockfile are unchanged.

## What is being measured

Every sample launches a fresh public CLI process. "First" means first observation
in a prepared fixture, **not** a dropped page cache, fresh machine or cold CPU.
Repeated samples may benefit from OS and tsx caches; no daemon stays warm.
Seven observations are a diagnostic sample, not a tail-latency confidence study.
Keep first, all raw samples, median and range; do not discard inconvenient runs.

The Node entry wrapper spawns another Node process with the tsx import hook.
Measuring an imported service or only `node --version` would omit this cost.
The macOS resource probe uses the same public wrapper; Docker uses the existing
E2E harness, including its routing/trace overhead. These are separate environments,
not interchangeable samples for a single aggregate.

## Reproduce startup resources (macOS)

With the checkout dependencies installed and the desired Node on PATH:

```bash
node scripts/benchmark-startup.mjs > /tmp/tmt-startup-run-1.json
node scripts/benchmark-startup.mjs > /tmp/tmt-startup-run-2.json
```

The script uses macOS `/usr/bin/time -lp` and the existing bounded
[packed-command runner](scripts/packed-command.mjs). It creates and removes a
private home/config/workspace, omits caller environment, blocks PATH-based tmux
execution and asserts command output. Each create uses a new storage directory;
show reads that identity in a later process. It never installs globally or
accesses a host tmux server. Restrictive sandboxes may deny kernel clock statistics;
that is a measurement failure, not a zero resource sample. Linux resource
accounting is not implemented by this macOS-only probe.

CPU includes waited descendants; user and system values have time-tool precision.
Maximum resident set size is reported in **bytes** on macOS. It is not the sum of
simultaneously resident wrapper/child processes, and is not idle agent memory.
Wall time includes the measurement shell/time wrappers and output capture.
No mocked agent, server or request waiting is included in these resource samples.

[Raw startup evidence](benchmarks/ts-startup-resources.json) wraps two unmodified
JSON outputs as `runs`, with `baselineRevision` recording the inspected production
reference. Recreate that wrapper with any JSON tool; there is no hidden statistical
transformation. Runs were collected on 2026-09-07 with Node 24.20.0, Apple M4 Pro,
arm64 and Darwin kernel 25.6.0. A future comparison records its own commit,
dirty production diff, compiler/build profile and environment rather than reusing
this reference label.

| Scenario              | Run 1 median / range (ms) | Run 2 median / range (ms) | Median user + system CPU (s), runs 1 / 2 | Median maximum RSS (MB, decimal), runs 1 / 2 |
| --------------------- | ------------------------- | ------------------------- | ---------------------------------------- | -------------------------------------------- |
| Help                  | 138.6 / 137.3–139.9       | 150.7 / 146.9–154.5       | 0.14 + 0.02 / 0.15 + 0.03                | 100.8 / 99.8                                 |
| Fresh storage create  | 142.7 / 142.1–144.7       | 158.2 / 153.1–160.4       | 0.14 + 0.02 / 0.15 + 0.03                | 102.6 / 101.3                                |
| Existing storage show | 140.7 / 137.8–143.7       | 153.9 / 152.9–155.8       | 0.14 + 0.02 / 0.15 + 0.03                | 101.4 / 100.1                                |

The roughly 9–11% inter-run latency shift is larger than several per-operation
differences. Startup is a plausible optimization target, not proof that SQL is
free or that Rust has achieved any speedup. The separately calculated median
user/system columns are not a median of their summed per-sample values.

The probe was also run with a missing Node on the child's PATH: it failed nonzero
and removed its temporary root. An initial incorrect help expectation failed
rather than yielding timing evidence; it was corrected against the actual help.
This verifies benchmark failure propagation, not the full future native
process-tree cleanup contract. The reused runner owns group cleanup; native
lifecycle acceptance remains a separate E2E gate.

## Reproduce isolated tmux and request latency

Use the pinned E2E Dockerfile and a task-owned image; do not run tmux scenarios
on the host. No extra benchmark dependency or second test framework is installed.

```bash
docker build -f test/e2e/Dockerfile -t tmt-performance-local .
docker run --rm --init --network none \
  -e TMT_PERFORMANCE_BASELINE=1 tmt-performance-local \
  pnpm exec vitest run --config test/e2e/vitest.config.ts \
  test/e2e/performance-baseline.e2e.test.ts
docker image rm tmt-performance-local
```

Repeat the container run before removing the image. The opt-in scenario prints
one `TMT_PERFORMANCE_BASELINE` JSON report and otherwise stays skipped in ordinary
CI. It uses private servers, deterministic mock replies, independent identity
state observations and the existing tmux invocation trace. Assertions gate
behavior and subprocess bounds, never latency. A failed scenario is invalid
baseline evidence, even if it printed a report before teardown failed.

To exercise actual observer waiting, add `-e TMT_PERFORMANCE_SLOW_REPLY=1` to
the same container run. It injects a 1,500ms mock reply delay and records that
value in the report; the CLI defaults, sample count and assertions stay unchanged.
This is controlled peer latency, not a changed production timeout or a real AI
workload. Fast reports collected before this additive metadata field used the
fixture's zero-delay default.

Trace counts include the fixture's caller-session lookup as well as the CLI's
tmux calls. They count tmux invocations, not every helper process in the trace
wrapper. Logging normalizes multiline arguments without altering forwarded
payloads; a raw buffer round-trip tests that property. An initial calibration
run exposed the old trace splitting multiline payloads into fake invocations;
its incorrect counts are excluded, not presented as runtime performance.

The large case adds 200 unbound sleeping panes to the original mock-agent pane.
Creation/setup/metadata validation are outside samples. The benchmark reports
help, initial storage creation, existing identity reads, small/large whoami and
check, durable no-preamble talk and result. First storage creation is one sample
per container; repeated fresh-storage resource samples are provided above.
The existing harness has no child CPU/RSS accounting: those Docker metrics are
explicitly unavailable, never substituted with Vitest's own usage.

### Docker observations

[Raw Docker evidence](benchmarks/ts-docker-latency.json) preserves all three
corrected-trace reports. Run 1 may overlap local quality-check completion;
the table uses runs 2 and 3, collected before full E2E repeats with no other
task-owned test workload running. Host-wide quiescence is not claimed. These
use Node 22.23.2, tmux 3.3a, Linux kernel 7.0.12-linuxkit, arm64 and the pinned
Bookworm Dockerfile. Each repeated series has seven samples; initial identity
creation has one per container. Full first/raw/range data remains in the artifact.

| Scenario                            | Run 2 median (ms) | Run 3 median (ms) | Traced tmux calls per sample |
| ----------------------------------- | ----------------- | ----------------- | ---------------------------- |
| Help                                | 131.0             | 134.1             | 0                            |
| Initial storage create (one sample) | 146.0             | 153.1             | 0                            |
| Identity show                       | 141.8             | 139.2             | 0                            |
| Whoami, small                       | 154.6             | 153.4             | 5                            |
| Whoami, 201 panes                   | 155.7             | 155.0             | 5                            |
| Check, small                        | 152.3             | 155.4             | 6                            |
| Check, 201 panes                    | 155.3             | 158.0             | 6                            |
| Talk, immediate mock final          | 699.9             | 698.2             | 13                           |
| Result                              | 141.4             | 140.9             | 0                            |

Defaults observed through `config show` were 180s timeout, 1s polling and 500ms
paste/Enter delay. Samples use an 8s talk timeout and no preamble. Fast mock
submission may finish during the send delay, so the approximately 700ms round
trip is not proof of fast polling or representative AI execution time.

With the same scenario and an injected 1,500ms peer delay,
[two additional reports](benchmarks/ts-docker-delayed-reply.json) measured talk
medians of 2,707.5ms and 2,706.2ms; result reads remained 143.4ms and 141.9ms.
Each report includes seven exact-body/correlated-final checks and verified fixture
cleanup. The roughly 2.7s round trip includes startup, send delay, peer latency
and the configured 1s polling cadence. This is evidence that waiting policy can
dominate the total; subtracting 1,500ms would not isolate pure TMT processing.
No delay or polling default was changed to obtain these measurements.

## Native comparison and acceptance

Executable selection is [#95](https://github.com/wkh237/tmux-team/issues/95), not
implemented here. That slice must also let the resource probe select the native
executable without changing measurement semantics. Measure **release** builds;
record toolchain, locked dependencies, target/linkage, binary size and source head.

- Run old and new binaries on the same machine/container/resources with the same
  fixture sizes, request body and delays. Interleave their order across at least
  two runs, with at least seven samples per repeated scenario. Re-baseline TS
  alongside Rust instead of comparing a different machine to this historical file.
- Keep all correctness/cleanup/compatibility gates mandatory. Timing gains cannot
  compensate for lost receipts, weaker evidence checks or changed timeout semantics.
- The deterministic bound is unchanged scoped tmux subprocess counts as panes grow;
  also inspect output size and returned scope. Constant count does not prove
  constant tmux internal traversal time.
- A provisional startup goal is at least 30% lower paired median wall time and
  maximum RSS for help/storage, without increased CPU. This exceeds the observed
  approximately 11% inter-run shift, but is an engineering target, not a measured
  Rust result or an automatic CI threshold. Revisit if paired variance exceeds it.
- Investigate any repeated median regression above 15% in scoped tmux operations;
  this is a review trigger, not a flaky test assertion. For talk, report end-to-end
  time and configured delay/poll policy separately. Do not silently reduce delays
  to advertise a faster runtime or subtract them and claim precise service time.
- CPU/RSS for complete Docker request process trees, sustained throughput,
  contention, multiple peers and cross-platform distributions remain unmeasured.
  Add those profiles before making claims about high-volume capacity, not merely
  before publishing another small startup number.
