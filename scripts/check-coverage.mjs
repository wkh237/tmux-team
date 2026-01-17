#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = {
    threshold: 90,
    branchesThreshold: null,
    statementsThreshold: null,
    functionsThreshold: null,
    linesThreshold: null,
    files: [],
    coverageDir: 'coverage',
    filesOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold' || a === '-t') {
      out.threshold = Number(argv[++i]);
    } else if (a === '--branches' || a === '--branches-threshold') {
      out.branchesThreshold = Number(argv[++i]);
    } else if (a === '--statements' || a === '--statements-threshold') {
      out.statementsThreshold = Number(argv[++i]);
    } else if (a === '--functions' || a === '--functions-threshold') {
      out.functionsThreshold = Number(argv[++i]);
    } else if (a === '--lines' || a === '--lines-threshold') {
      out.linesThreshold = Number(argv[++i]);
    } else if (a === '--file' || a === '-f') {
      out.files.push(argv[++i]);
    } else if (a === '--coverage-dir') {
      out.coverageDir = argv[++i];
    } else if (a === '--files-only') {
      out.filesOnly = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (!a.startsWith('-')) {
      out.files.push(a);
    }
  }
  return out;
}

function usage() {
  console.log(`check-coverage

Usage:
  node scripts/check-coverage.mjs [--threshold 90] [--file <path> ...]
  node scripts/check-coverage.mjs --files-only [--threshold 90] [--file <path> ...]
  node scripts/check-coverage.mjs --branches 85 [--threshold 90]

Notes:
  - Reads coverage from coverage/coverage-summary.json (Vitest json-summary reporter)
  - By default, enforces overall (total) coverage, and also enforces any provided --file targets
  - Use --files-only to skip the overall (total) enforcement
`);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function normalizeInputFile(file) {
  if (!file) return '';
  return path.normalize(file);
}

function normalizeCoverageKey(key) {
  // Coverage summary keys are usually absolute paths; normalize so we can match by suffix.
  return path.normalize(key);
}

function pct(v) {
  return typeof v?.pct === 'number' ? v.pct : null;
}

function checkEntry(name, entry, thresholds) {
  const metrics = {
    statements: pct(entry.statements),
    branches: pct(entry.branches),
    functions: pct(entry.functions),
    lines: pct(entry.lines),
  };

  const failures = Object.entries(metrics)
    .filter(([metric, value]) => {
      if (value === null) return false;
      const required = thresholds[metric] ?? thresholds.default;
      return value < required;
    })
    .map(([metric, value]) => ({ metric, value }));

  return { name, metrics, failures };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 100) {
  console.error(`Invalid --threshold: ${args.threshold}. Must be between 0 and 100.`);
  process.exit(1);
}
for (const [key, value] of Object.entries({
  branches: args.branchesThreshold,
  statements: args.statementsThreshold,
  functions: args.functionsThreshold,
  lines: args.linesThreshold,
})) {
  if (value === null || value === undefined) continue;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    console.error(`Invalid --${key}: ${value}. Must be between 0 and 100.`);
    process.exit(1);
  }
}

const summaryPath = path.resolve(args.coverageDir, 'coverage-summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error(`Coverage summary not found: ${summaryPath}`);
  console.error(
    `Run vitest with coverage enabled, e.g. "vitest run --coverage", and ensure json-summary reporter is configured.`
  );
  process.exit(1);
}

const summary = readJson(summaryPath);
if (!summary?.total) {
  console.error(`Invalid coverage summary format in ${summaryPath}`);
  process.exit(1);
}

const thresholds = {
  default: args.threshold,
  branches: args.branchesThreshold ?? args.threshold,
  statements: args.statementsThreshold ?? args.threshold,
  functions: args.functionsThreshold ?? args.threshold,
  lines: args.linesThreshold ?? args.threshold,
};
const requestedFiles = args.files.map(normalizeInputFile).filter(Boolean);

const results = [];

if (!args.filesOnly) {
  results.push(checkEntry('total', summary.total, thresholds));
}

if (requestedFiles.length === 0) {
  // Only total enforcement requested.
} else {
  const keys = Object.keys(summary).filter((k) => k !== 'total');
  const keyNorm = keys.map((k) => ({ raw: k, norm: normalizeCoverageKey(k) }));

  for (const f of requestedFiles) {
    const matches = keyNorm.filter(
      (k) => k.norm === f || k.norm.endsWith(path.sep + f) || k.norm.endsWith(f)
    );
    if (matches.length === 0) {
      console.error(`No coverage entry found for: ${f}`);
      console.error(`Tip: pass a path relative to repo root (e.g. src/commands/talk.ts).`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Ambiguous coverage match for: ${f}`);
      for (const m of matches) console.error(`- ${m.raw}`);
      process.exit(1);
    }
    results.push(checkEntry(f, summary[matches[0].raw], thresholds));
  }
}

const failures = results.flatMap((r) => r.failures.map((f) => ({ file: r.name, ...f })));

if (failures.length === 0) {
  process.exit(0);
}

console.error(
  `WARNING: Coverage does not fulfill the requirement (minimum ${thresholds.default}%).`
);
console.error(`Coverage below ${thresholds.default}%:`);
for (const f of failures) {
  console.error(`- ${f.file}: ${f.metric} ${f.value}%`);
}
process.exit(1);
