import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { imports } from '../test/support/source-imports.js';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));

function declaredTypes(text: string): string[] {
  const source = ts.createSourceFile('module.ts', text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return names;
}

function violations(file: string, text: string): string[] {
  const application =
    file.endsWith('-service.ts') ||
    file === 'identity-context.ts' ||
    file === 'target-resolver.ts' ||
    file === 'request-attention.ts';
  return imports(text).flatMap((specifier) => {
    const target = specifier.startsWith('.')
      ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      : specifier;
    const storage = target.startsWith('storage/') || target === 'better-sqlite3';
    const command = file.startsWith('commands/');
    if ((command || application) && storage) return [`${file} -> ${specifier}: storage detail`];
    if (
      file.startsWith('cli/') &&
      target.startsWith('commands/') &&
      file !== 'cli/application.ts'
    ) {
      return [`${file} -> ${specifier}: parser-to-command dependency`];
    }
    if (
      file.startsWith('domain/') &&
      (!target.startsWith('domain/') || !specifier.startsWith('.'))
    ) {
      return [`${file} -> ${specifier}: domain dependency outside pure domain`];
    }
    return [];
  });
}

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const location = path.join(directory, entry.name);
    if (directory === sourceRoot && entry.name === 'test-support') return [];
    if (entry.isDirectory()) return productionFiles(location);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [location] : [];
  });
}

describe('maintained application dependency boundaries', () => {
  it('recognizes duplicate request declarations without treating imports or comments as owners', () => {
    expect(declaredTypes('export interface ConfigRequest {}')).toEqual(['ConfigRequest']);
    expect(declaredTypes('type PreambleRequest = { kind: "preamble" };')).toEqual([
      'PreambleRequest',
    ]);
    expect(
      declaredTypes(
        'import type { ConfigRequest } from "./requests.js"; // type ConfigRequest = {}'
      )
    ).toEqual([]);
  });

  it('keeps shared CLI request declarations in their canonical module', () => {
    const owner = path.join(sourceRoot, 'cli', 'requests.ts');
    const ownedNames = new Set(declaredTypes(fs.readFileSync(owner, 'utf8')));
    expect(ownedNames.size).toBeGreaterThan(0);
    const duplicates = productionFiles(sourceRoot)
      .filter((file) => file !== owner)
      .flatMap((file) =>
        declaredTypes(fs.readFileSync(file, 'utf8'))
          .filter((name) => ownedNames.has(name))
          .map((name) => `${path.relative(sourceRoot, file)}: ${name}`)
      );
    expect(duplicates).toEqual([]);
  });

  it('detects static, re-export, dynamic, require and type-only storage dependencies', () => {
    const forms = [
      "import type { Repo } from '../storage/identity-repository.js';",
      "export { open } from '../storage/sqlite-adapter.js';",
      "const driver = import('better-sqlite3');",
      "const driver = require('better-sqlite3');",
      "type Repo = import('../storage/identity-repository.js').Repo;",
      "import driver = require('better-sqlite3');",
    ];
    for (const form of forms) expect(violations('commands/example.ts', form)).toHaveLength(1);
    expect(
      violations('role-service.ts', "import type { Repo } from './storage/identity-repository.js';")
    ).toHaveLength(1);
    expect(
      violations('cli/parser.ts', "import type { Request } from '../commands/role.js';")
    ).toHaveLength(1);
    expect(violations('domain/example.ts', "import fs from 'node:fs';")).toHaveLength(1);
    expect(
      violations('request-attention.ts', "import { open } from './storage/sqlite-adapter.js';")
    ).toHaveLength(1);
  });

  it('allows composition ownership, dispatcher routing and pure domain reuse', () => {
    expect(
      violations('context.ts', "import { open } from './storage/identity-repository.js';")
    ).toEqual([]);
    expect(
      violations('cli/application.ts', "import { cmdRole } from '../commands/role.js';")
    ).toEqual([]);
    expect(violations('domain/role.ts', "import { normalize } from './text-content.js';")).toEqual(
      []
    );
    expect(imports("// import driver from 'better-sqlite3';")).toEqual([]);
  });

  it('keeps checked-in services and command adapters independent of concrete storage', () => {
    const files = productionFiles(sourceRoot);
    expect(files.some((file) => file.endsWith('/identity-service.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('/commands/role.ts'))).toBe(true);
    const failures = files.flatMap((file) =>
      violations(
        path.relative(sourceRoot, file).split(path.sep).join('/'),
        fs.readFileSync(file, 'utf8')
      )
    );
    expect(failures).toEqual([]);
  });
});
