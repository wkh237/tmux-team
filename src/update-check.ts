// Local installation drift and cached npm update checks.

import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from './types.js';
import { VERSION } from './version.js';

export interface DriftIssue {
  kind: 'legacy' | 'broken-link' | 'wrong-link' | 'outdated-copy';
  path: string;
  message: string;
}

function packageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(currentFile);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(currentFile), '..');
}

function existsAsPath(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function correctLink(target: string, source: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return (
      stat.isSymbolicLink() &&
      path.resolve(path.dirname(target), fs.readlinkSync(target)) === path.resolve(source)
    );
  } catch {
    return false;
  }
}

function linkIssue(
  target: string,
  source: string,
  label: string,
  allowCopiedFile = false
): DriftIssue | undefined {
  if (!existsAsPath(target)) return undefined;
  if (correctLink(target, source)) return undefined;
  let kind: DriftIssue['kind'] = 'wrong-link';
  try {
    const stat = fs.lstatSync(target);
    if (stat.isFile() && allowCopiedFile) return undefined;
    if (stat.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(target), fs.readlinkSync(target));
      kind = fs.existsSync(resolved) ? 'wrong-link' : 'broken-link';
    }
  } catch {
    kind = 'broken-link';
  }
  return {
    kind,
    path: target,
    message: `${label} is not the managed link (${target})`,
  };
}

export interface DriftOptions {
  home?: string;
  codexHome?: string;
  root?: string;
}

/** Inspect only local files; this never contacts the network. */
export function inspectLocalDrift(options: DriftOptions = {}): DriftIssue[] {
  const home = options.home ?? os.homedir();
  const root = options.root ?? packageRoot();
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex');
  const universal = path.join(root, 'skills', 'tmux-team');
  const claudeSource = path.join(root, 'skills', 'claude', 'team.md');
  const agentsTarget = path.join(home, '.agents', 'skills', 'tmux-team');
  const claudeTarget = path.join(home, '.claude', 'commands', 'team.md');
  const issues: DriftIssue[] = [];

  for (const legacy of [
    path.join(home, '.codex', 'skills', 'tmux-team', 'SKILL.md'),
    path.join(codexHome, 'skills', 'tmux-team', 'SKILL.md'),
  ]) {
    if (existsAsPath(legacy) && !issues.some((issue) => issue.path === legacy)) {
      issues.push({
        kind: 'legacy',
        path: legacy,
        message: `Legacy copied Codex skill found at ${legacy}`,
      });
    }
  }
  const universalIssue = linkIssue(agentsTarget, universal, 'Open Agent skill');
  if (universalIssue) issues.push(universalIssue);
  const claudeIssue = linkIssue(claudeTarget, claudeSource, 'Claude command', true);
  if (claudeIssue) issues.push(claudeIssue);

  // A regular Claude file is a supported legacy install, but warn when it has drifted.
  try {
    if (
      fs.lstatSync(claudeTarget).isFile() &&
      fs.readFileSync(claudeTarget, 'utf8') !== fs.readFileSync(claudeSource, 'utf8')
    ) {
      issues.push({
        kind: 'outdated-copy',
        path: claudeTarget,
        message: `Claude command copy is out of date (${claudeTarget})`,
      });
    }
  } catch {
    // Missing files and unreadable targets are handled by the link inspection above.
  }
  return issues;
}

interface VersionCache {
  checkedAt: number;
  latestVersion: string;
}

function parseVersion(value: string): [number, number, number, string] | undefined {
  const match = value
    .trim()
    .replace(/^v/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''] : undefined;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  // A normal release is newer than its prerelease. Prerelease ordering is kept
  // deterministic for the cache check without pulling in a semver dependency.
  if (!a[3] && b[3]) return true;
  if (a[3] && !b[3]) return false;
  return a[3] > b[3];
}

function readCache(cachePath: string): VersionCache | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as VersionCache;
    if (typeof value.checkedAt === 'number' && typeof value.latestVersion === 'string')
      return value;
  } catch {
    // A corrupt cache is treated as a cache miss.
  }
  return undefined;
}

function fetchLatestVersion(timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const request = https.get(
      'https://registry.npmjs.org/tmux-team/latest',
      { headers: { accept: 'application/json' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { version?: string };
            resolve(parsed.version);
          } catch {
            resolve(undefined);
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(undefined);
    });
    request.on('error', () => resolve(undefined));
  });
}

export async function checkLatestVersion(
  globalDir: string,
  currentVersion = VERSION
): Promise<string | undefined> {
  const cachePath = path.join(globalDir, 'version-check.json');
  const now = Date.now();
  const cached = readCache(cachePath);
  if (cached && now - cached.checkedAt < 24 * 60 * 60 * 1000) {
    return isNewerVersion(cached.latestVersion, currentVersion) ? cached.latestVersion : undefined;
  }
  const latest = await fetchLatestVersion(1500);
  if (!latest) return undefined;
  try {
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: now, latestVersion: latest }) + '\n');
  } catch {
    // The update check must never make a command fail.
  }
  return isNewerVersion(latest, currentVersion) ? latest : undefined;
}

const SUPPRESSED_COMMANDS = new Set(['install', 'upgrade', 'help', 'version', 'completion']);

export async function runStartupChecks(ctx: Context, command: string): Promise<void> {
  if (ctx.flags.json || SUPPRESSED_COMMANDS.has(command)) return;
  const drift = inspectLocalDrift();
  if (drift.length > 0) {
    ctx.ui.warn(
      `${drift[0].message}. Run "tmt install --force" to refresh.${drift.length > 1 ? ` (+${drift.length - 1} more)` : ''}`
    );
  }
  // Avoid adding latency or output to non-interactive pipelines.
  if (!process.stdin.isTTY) return;
  const latest = await checkLatestVersion(ctx.paths.globalDir, VERSION);
  if (latest)
    ctx.ui.warn(`tmux-team ${latest} is available (current: ${VERSION}). Run "tmt upgrade".`);
}
