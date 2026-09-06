import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { checkProjections, PROJECTIONS, writeProjections } = (await import(
  pathToFileURL(path.join(repositoryRoot, 'scripts', 'skill-projections.mjs')).href
)) as unknown as {
  checkProjections: (root: string) => { checked: number };
  PROJECTIONS: readonly { output: string; template: string }[];
  writeProjections: (root: string) => { changed: string[] };
};

function createFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tmt-skill-projections-'));
  try {
    mkdirSync(path.join(root, 'skills', 'tmux-team'), { recursive: true });
    mkdirSync(path.join(root, 'scripts', 'skill-projection-templates'), { recursive: true });
    copyFileSync(
      path.join(repositoryRoot, 'skills', 'tmux-team', 'SKILL.md'),
      path.join(root, 'skills', 'tmux-team', 'SKILL.md')
    );
    copyFileSync(
      path.join(repositoryRoot, 'scripts', 'skill-projections.mjs'),
      path.join(root, 'scripts', 'skill-projections.mjs')
    );
    for (const projection of PROJECTIONS) {
      copyFileSync(
        path.join(repositoryRoot, 'scripts', 'skill-projection-templates', projection.template),
        path.join(root, 'scripts', 'skill-projection-templates', projection.template)
      );
    }
    return root;
  } catch (error) {
    removeFixture(root);
    throw error;
  }
}

function removeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe('skill projections', () => {
  it('writes five standalone projections and checks them without touching the canonical source', () => {
    const root = createFixture();
    try {
      const canonicalPath = path.join(root, 'skills', 'tmux-team', 'SKILL.md');
      const canonicalBefore = readFileSync(canonicalPath, 'utf8');
      const canonicalBody = canonicalBefore
        .slice(frontmatter(canonicalBefore).length)
        .replace(/^\r?\n+/, '');
      expect(writeProjections(root).changed).toHaveLength(5);
      expect(checkProjections(root)).toEqual({ checked: 5 });
      expect(readFileSync(canonicalPath, 'utf8')).toBe(canonicalBefore);
      for (const projection of PROJECTIONS) {
        const template = readFileSync(
          path.join(root, 'scripts', 'skill-projection-templates', projection.template),
          'utf8'
        );
        const generated = readFileSync(path.join(root, projection.output), 'utf8');
        expect(frontmatter(generated)).toBe(frontmatter(template));
        expect(generated).toContain(canonicalBody);
        expect(generated.endsWith('\n')).toBe(true);
        expect(generated.endsWith('\n\n')).toBe(false);
      }
      expect(readFileSync(path.join(root, 'skills', 'codex', 'SKILL.md'), 'utf8')).toContain(
        'When invoked, execute the `tmt`'
      );
      expect(readFileSync(path.join(root, 'skills', 'claude', 'team.md'), 'utf8')).toContain(
        'Execute this command: `tmt $ARGUMENTS`'
      );
      expect(
        readFileSync(
          path.join(root, 'plugins', 'tmux-team', 'skills', 'tmux-team', 'SKILL.md'),
          'utf8'
        )
      ).toContain('## When to Use This Skill');
      expect(
        readFileSync(path.join(root, 'plugins', 'tmux-team', 'commands', 'team.md'), 'utf8')
      ).toContain("Interpret the user's request: $ARGUMENTS");
      expect(
        readFileSync(path.join(root, 'plugins', 'tmux-team', 'commands', 'learn.md'), 'utf8')
      ).toContain('# Learn tmux-team');
      for (const projection of PROJECTIONS) {
        expect(readFileSync(path.join(root, projection.output), 'utf8')).not.toContain(
          '<!-- TMT-CANONICAL-BODY -->'
        );
      }
    } finally {
      removeFixture(root);
    }
  });

  it('is idempotent and regenerates every projection after a canonical edit', () => {
    const root = createFixture();
    try {
      writeProjections(root);
      expect(writeProjections(root)).toEqual({ changed: [] });
      const canonicalPath = path.join(root, 'skills', 'tmux-team', 'SKILL.md');
      const canonical = readFileSync(canonicalPath, 'utf8');
      const literalExample = "Canonical fixture edit: $& $` $' $$";
      writeFileSync(
        canonicalPath,
        canonical.replace('## Delivery safety', () => `## Delivery safety\n\n${literalExample}`)
      );
      expect(writeProjections(root).changed).toHaveLength(5);
      expect(checkProjections(root)).toEqual({ checked: 5 });
      expect(readFileSync(path.join(root, 'skills', 'codex', 'SKILL.md'), 'utf8')).toContain(
        literalExample
      );
      expect(readFileSync(path.join(root, 'skills', 'codex', 'SKILL.md'), 'utf8')).toContain(
        'When invoked, execute the `tmt`'
      );
    } finally {
      removeFixture(root);
    }
  });

  it('rejects an altered or missing derived file', () => {
    const root = createFixture();
    try {
      writeProjections(root);
      const derivedPath = path.join(root, PROJECTIONS[0].output);
      writeFileSync(
        derivedPath,
        readFileSync(derivedPath, 'utf8').replace('## Delivery safety', '## Corrupted safety')
      );
      expect(() => checkProjections(root)).toThrow(/skills\/codex\/SKILL\.md/);
      writeProjections(root);
      unlinkSync(path.join(root, PROJECTIONS[1].output));
      expect(() => checkProjections(root)).toThrow(/skills\/claude\/team\.md.*missing/);
    } finally {
      removeFixture(root);
    }
  });

  it(
    'rejects drift through the CLI and validates templates before writing',
    { timeout: 15_000 },
    () => {
      const root = createFixture();
      try {
        writeProjections(root);
        const derivedPath = path.join(root, PROJECTIONS[0].output);
        writeFileSync(
          derivedPath,
          readFileSync(derivedPath, 'utf8').replace('## Delivery safety', '## Corrupted safety')
        );
        const scriptPath = path.join(root, 'scripts', 'skill-projections.mjs');
        const result = spawnSync(process.execPath, [scriptPath, 'check'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 5_000,
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Skill projection drift detected');

        const canonicalPath = path.join(root, 'skills', 'tmux-team', 'SKILL.md');
        const canonical = readFileSync(canonicalPath, 'utf8');
        writeFileSync(
          canonicalPath,
          canonical.replace('## Delivery safety', '## Delivery safety\n\nCanonical preflight edit.')
        );
        const before = new Map(
          PROJECTIONS.map((projection) => [
            projection.output,
            readFileSync(path.join(root, projection.output), 'utf8'),
          ])
        );
        const templatePath = path.join(
          root,
          'scripts',
          'skill-projection-templates',
          PROJECTIONS.at(-1)!.template
        );
        writeFileSync(
          templatePath,
          `${readFileSync(templatePath, 'utf8')}<!-- TMT-CANONICAL-BODY -->\n`
        );
        expect(() => writeProjections(root)).toThrow(/exactly one/);
        for (const [relativePath, content] of before) {
          expect(readFileSync(path.join(root, relativePath), 'utf8')).toBe(content);
        }

        const extraArgument = spawnSync(process.execPath, [scriptPath, 'check', 'unexpected'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 5_000,
        });
        expect(extraArgument.status).toBe(1);
        expect(extraArgument.stderr).toContain(
          'Usage: node scripts/skill-projections.mjs [check|write]'
        );
      } finally {
        removeFixture(root);
      }
    }
  );
});

function frontmatter(source: string): string {
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!match) throw new Error('Expected projection frontmatter');
  return match[0];
}
