#!/usr/bin/env tsx

import { runCli } from './cli-runner.js';

export function main(): void {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      // Let stdout/stderr drain before Node exits, including large JSON results.
      process.exitCode = code;
    },
    (error: unknown) => {
      process.exitCode = 1;
      console.error(error instanceof Error ? error.message : String(error));
    }
  );
}

main();
