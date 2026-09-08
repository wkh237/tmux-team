# Runtime performance evidence

## Native closeout comparison (#151)

The native alpha is published. Collected before TypeScript source retirement,
this comparison measures both runtimes from source `e3c8bd7e9a2fdaab0ccfe59a03be7967a7719fcb`
on the same host with unchanged command defaults. All raw observations, source
trees, build identity and failed-calibration dispositions are retained in
[paired evidence](benchmarks/native-paired-performance.json). The historical
baseline below remains unchanged evidence, not the denominator for this comparison.

The native build uses Rust 1.97.0, locked dependencies, release optimization,
thin LTO and stripped debug information. macOS uses aarch64-apple-darwin; Docker
uses aarch64-unknown-linux-gnu in the existing pinned Bookworm fixture. The latter
is not the published static-musl archive. The measured macOS executable is
7,344,960 bytes. These are same-source optimized builds, not an installed-binary
update or a claim that different target linkages have identical performance.

### Paired startup resources

Collected on 2026-09-08, Apple M4 Pro/arm64, Darwin 25.6.0 and Node 24.20.0
for test tooling. Order was TS, native, native, TS, with seven fresh-process
samples per scenario per run. No other task-owned build/test workload ran during
collection; host-wide quiescence and dropped OS caches are not claimed.

| Scenario              | TS median ms, runs 1 / 2 | Native median ms, runs 1 / 2 | TS median RSS MB, runs 1 / 2 | Native median RSS MB, runs 1 / 2 |
| --------------------- | ------------------------ | ---------------------------- | ---------------------------- | -------------------------------- |
| Help                  | 156.72 / 158.82          | 14.85 / 15.03                | 100.73 / 100.37              | 8.39 / 8.36                      |
| Fresh storage create  | 162.37 / 165.69          | 18.90 / 19.16                | 102.25 / 102.04              | 11.17 / 11.16                    |
| Existing storage show | 158.66 / 158.81          | 15.41 / 16.42                | 100.30 / 100.56              | 10.47 / 10.47                    |

All paired medians exceed the previously recorded 30% wall/RSS improvement goal:
roughly 88–91% less wall time and 89–92% less maximum RSS in these scenarios.
TS median per-sample user+system CPU is 0.18–0.19 seconds; native medians round
to 0.00 at the time tool's centisecond precision. This is not zero CPU usage.
RSS is a process-tree maximum, not summed concurrent memory. Wall time includes
the measurement wrappers. Show must return the exact identity UUID/content
created by the preceding process, not merely a matching display name.

### Paired private-tmux latency

For each peer delay, collection order was TS, native, native, TS in separate
network-isolated containers from the same image.
The Docker VM exposes 12 CPUs and 8,319,238,144 bytes of memory, without additional
per-container CPU or memory limits in either runtime's run. Both originator and mock-reply
CLI descriptors select the same runtime. Each repeated series has seven samples;
fresh identity creation has one per container. All eight reports passed exact
reply/result, independent identity-state, no-tmux and fixture-cleanup assertions.

| Scenario                   | TS median ms, runs 1 / 2 | Native median ms, runs 1 / 2 | Traced tmux calls TS / native |
| -------------------------- | ------------------------ | ---------------------------- | ----------------------------- |
| Whoami, small              | 167.20 / 156.20          | 10.05 / 7.99                 | 5 / 4                         |
| Whoami, 201 panes          | 167.39 / 160.90          | 9.66 / 10.77                 | 5 / 4                         |
| Check, small               | 165.00 / 157.00          | 9.68 / 10.83                 | 6 / 5                         |
| Check, 201 panes           | 167.76 / 161.17          | 13.11 / 12.17                | 6 / 5                         |
| Talk, immediate mock final | 707.01 / 707.79          | 538.87 / 543.08              | 13 / 12                       |
| Result, immediate series   | 151.37 / 143.47          | 2.04 / 2.11                  | 0 / 0                         |
| Talk, 1,500 ms mock delay  | 2720.55 / 2717.57        | 1544.16 / 1543.94            | 13 / 12                       |

The deterministic small/large scoped subprocess-count gates pass for every
sample, and there is no repeated native-versus-TS scoped median regression.
Constant call counts do not imply constant internal tmux traversal time: native
large-session checks still take several milliseconds more than small ones.
Counts include fixture session discovery and are not total OS process counts.

Both reports observe the same 500 ms paste/Enter delay and 1-second poll interval;
the benchmark uses an 8-second timeout and no preamble. Reply arrival relative
to polling can move completion by an entire interval. The delayed round-trip
difference is not a direct measurement of pure TMT processing or permission to
subtract the mock delay and claim service time. No production timing changed.

### Measurement corrections and remaining limits

The old help-heading assertion rejected native output. Both benchmarks now use
one independent command-presence oracle with missing-command/false-output tests.
An initial native tmux calibration then failed because the trace labeled the
global `-S` option as the command. Tracing now shares the fixture's existing
argv inspection; actual ambient/explicit-socket buffer round trips preserve
multiline and option-like payload bytes. Neither failed calibration produced
accepted native timing evidence; all paired Docker runs were recollected.

Reproduce using the existing commands below, adding
`--build-arg TMT_NATIVE_PROFILE=release` to Docker build and selecting
`TMT_TEST_CLI='{"executable":"/opt/tmt-tests/tmt","args":[]}'` for native container
runs. The peer inherits that descriptor. Default Docker regression builds remain
debug; the profile option only selects the measured CLI, not another harness.

This satisfies paired startup/scoped-latency acceptance, not all of #93.
Complete Docker request-process CPU/RSS, sustained contention, multiple active
peers and cross-platform distributions remain unmeasured. No high-volume capacity
or universal speedup claim follows from these results. Source/test ownership
cleanup is sequenced in #152 before removal of the reference runtime.

## Historical TypeScript baseline

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

Executable selection is provided by [#95](https://github.com/wkh237/tmux-team/issues/95).
Use [the shared descriptors](DEVELOPMENT.md#selecting-the-cli-under-test) for both
the resource probe and Docker scenarios. New reports record the selected executable
(and the Docker peer); historical raw baseline reports remain unchanged. The Node
version describes test tooling, not proof that the selected executable uses Node.
Resource accounting and output assertions are unchanged. The shared default now
pins the test runner's Node executable and invokes the same public wrapper,
instead of finding Node through its shebang and PATH. Re-baseline both runtimes
with this launcher for comparisons; do not claim these historical timings are
measurements of the new launcher. Measure **release** builds;
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
