import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultNativeExecutable = fileURLToPath(
  new URL('../../rust/target/debug/tmt', import.meta.url)
);

// Test infrastructure only. Production commands never inspect these selectors.
export function resolveCliExecutables(env = process.env) {
  const cli = resolveDescriptor(env.TMT_TEST_CLI, 'TMT_TEST_CLI');
  const peer =
    env.TMT_TEST_PEER_CLI === undefined
      ? cli
      : resolveDescriptor(env.TMT_TEST_PEER_CLI, 'TMT_TEST_PEER_CLI');
  return Object.freeze({ cli, peer });
}

function resolveDescriptor(serialized, label) {
  let value;
  try {
    value =
      serialized === undefined
        ? { executable: defaultNativeExecutable, args: [] }
        : JSON.parse(serialized);
  } catch {
    throw new Error(`${label} must be a JSON executable descriptor.`);
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'executable' && key !== 'args') ||
    typeof value.executable !== 'string' ||
    !path.isAbsolute(value.executable) ||
    value.executable.includes('\0') ||
    !Array.isArray(value.args) ||
    !value.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
  ) {
    throw new Error(
      `${label} requires an absolute executable and a string-array args prefix; no other keys are accepted.`
    );
  }
  try {
    if (!fs.statSync(value.executable).isFile()) throw new Error('not a regular file');
    fs.accessSync(value.executable, fs.constants.X_OK);
  } catch (error) {
    const hint =
      serialized === undefined
        ? ' Build it with cargo build --manifest-path rust/Cargo.toml --locked, or set an explicit test executable descriptor.'
        : '';
    throw new Error(
      `${label} executable is unavailable or not executable: ${value.executable}.${hint}`,
      {
        cause: error,
      }
    );
  }
  return Object.freeze({ executable: value.executable, args: Object.freeze([...value.args]) });
}
