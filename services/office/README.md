# Office service boundary

Reserved for Firebase rules, indexes and emulator tests under #176 after the
trust model in #174. No deployable service or cloud configuration exists yet.

See [the architecture](../../docs/office/architecture.md). Add functions only
when a trusted operation cannot be safely implemented with reviewed rules and
client contracts. Never place local TMT database or process access here.
