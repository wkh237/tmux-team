import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { imports } from '../support/source-imports.js';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

function retainedTestFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return retainedTestFiles(file);
    return /\.(?:ts|mjs)$/.test(entry.name) ? [file] : [];
  });
}

function legacyTestImports(file: string, text: string): string[] {
  return imports(text).filter((specifier) => {
    if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return false;
    const target = path.resolve(path.dirname(file), specifier);
    const relative = path.relative(sourceRoot, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

describe('retained developer tooling boundaries', () => {
  it('rejects legacy runtime imports from retained native test infrastructure', () => {
    const file = path.join(sourceRoot, '../test/native/example.ts');
    for (const form of [
      "import { open } from '../../src/storage/sqlite-adapter.js';",
      "export * from '../../src/config.js';",
      "const legacy = import('../../src/context.js');",
      "const legacy = require('../../src/context.js');",
      "type Legacy = import('../../src/context.js').Context;",
    ])
      expect(legacyTestImports(file, form)).toHaveLength(1);
    expect(legacyTestImports(file, "import { runCli } from '../support/cli-process.js';")).toEqual(
      []
    );
    expect(legacyTestImports(file, "import Database from 'better-sqlite3';")).toEqual([]);
    expect(legacyTestImports(file, "// import legacy from '../../src/context.js';")).toEqual([]);
  });

  it('keeps all retained test modules independent of the TypeScript product', () => {
    const directories = ['native', 'e2e', 'support', 'tooling'].map((name) =>
      path.join(sourceRoot, '../test', name)
    );
    const files = directories.flatMap(retainedTestFiles);
    expect(files.some((file) => file.endsWith('/storage-fixture.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('/cli-process.ts'))).toBe(true);
    expect(
      files.flatMap((file) =>
        legacyTestImports(file, fs.readFileSync(file, 'utf8')).map(
          (specifier) => `${file} -> ${specifier}`
        )
      )
    ).toEqual([]);
  });
});
