import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CANONICAL_RELATIVE_PATH = 'skills/tmux-team/SKILL.md';
const BODY_MARKER = '<!-- TMT-CANONICAL-BODY -->';

// This is intentionally a fixed projection list. These are the shipped files
// whose provider wrappers must contain the same standalone semantic body.
export const PROJECTIONS = Object.freeze([
  { output: 'skills/codex/SKILL.md', template: 'codex.md' },
  { output: 'skills/claude/team.md', template: 'claude.md' },
  {
    output: 'plugins/tmux-team/skills/tmux-team/SKILL.md',
    template: 'plugin-skill.md',
  },
  { output: 'plugins/tmux-team/commands/team.md', template: 'plugin-team.md' },
  { output: 'plugins/tmux-team/commands/learn.md', template: 'plugin-learn.md' },
]);

function repositoryRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function readCanonicalBody(root) {
  const relativePath = CANONICAL_RELATIVE_PATH;
  const filePath = path.join(root, relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  const frontmatter = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!frontmatter) {
    throw new Error(`Canonical skill is missing frontmatter: ${relativePath}`);
  }
  const body = source.slice(frontmatter[0].length).replace(/^\r?\n+/, '');
  if (!body.trim()) throw new Error(`Canonical skill body is empty: ${relativePath}`);
  return body.endsWith('\n') ? body : `${body}\n`;
}

function renderProjection(root, projection, canonicalBody) {
  const templatePath = path.join(
    root,
    'scripts',
    'skill-projection-templates',
    projection.template
  );
  const template = fs.readFileSync(templatePath, 'utf8');
  const markerCount = template.split(BODY_MARKER).length - 1;
  if (markerCount !== 1) {
    throw new Error(
      `Projection template must contain exactly one ${BODY_MARKER}: ${projection.template}`
    );
  }
  const rendered = template.replace(BODY_MARKER, () => canonicalBody);
  return `${rendered.replace(/(?:\r?\n)+$/, '')}\n`;
}

function renderedProjections(root) {
  const canonicalBody = readCanonicalBody(root);
  return PROJECTIONS.map((projection) => ({
    ...projection,
    content: renderProjection(root, projection, canonicalBody),
  }));
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const length = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < length; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return `line ${index + 1}: expected ${JSON.stringify(expectedLines[index] ?? '')}, got ${JSON.stringify(actualLines[index] ?? '')}`;
    }
  }
  return 'content differs';
}

export function checkProjections(root = repositoryRoot()) {
  const resolvedRoot = path.resolve(root);
  const failures = [];
  for (const projection of renderedProjections(resolvedRoot)) {
    const outputPath = path.join(resolvedRoot, projection.output);
    if (!fs.existsSync(outputPath)) {
      failures.push(`${projection.output}: generated file is missing`);
      continue;
    }
    const actual = fs.readFileSync(outputPath, 'utf8');
    if (actual !== projection.content) {
      failures.push(`${projection.output}: ${firstDifference(projection.content, actual)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Skill projection drift detected:\n${failures.map((failure) => `- ${failure}`).join('\n')}`
    );
  }
  return { checked: PROJECTIONS.length };
}

export function writeProjections(root = repositoryRoot()) {
  const resolvedRoot = path.resolve(root);
  const changed = [];
  for (const projection of renderedProjections(resolvedRoot)) {
    const outputPath = path.join(resolvedRoot, projection.output);
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : undefined;
    if (current === projection.content) continue;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, projection.content);
    changed.push(projection.output);
  }
  return { changed };
}

function main() {
  if (process.argv.length > 3) {
    throw new Error('Usage: node scripts/skill-projections.mjs [check|write]');
  }
  const command = process.argv[2] ?? 'check';
  if (command === 'check') {
    const result = checkProjections();
    console.log(`Checked ${result.checked} skill projections.`);
    return;
  }
  if (command === 'write') {
    const result = writeProjections();
    console.log(
      result.changed.length === 0
        ? `Skill projections are up to date (${PROJECTIONS.length} checked).`
        : `Wrote ${result.changed.length} skill projections.`
    );
    return;
  }
  throw new Error('Usage: node scripts/skill-projections.mjs [check|write]');
}

const entryUrl = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : undefined;
if (entryUrl === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
