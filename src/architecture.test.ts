import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));

function imports(text: string): string[] {
  const source = ts.createSourceFile('module.ts', text, ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  const collect = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      values.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      values.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      values.push(node.argument.literal.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      values.push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return values;
}

function violations(file: string, text: string): string[] {
  const application =
    file.endsWith('-service.ts') || file === 'identity-context.ts' || file === 'target-resolver.ts';
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
    if (entry.isDirectory()) return productionFiles(location);
    return entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('-worker.ts')
      ? [location]
      : [];
  });
}

describe('maintained application dependency boundaries', () => {
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
