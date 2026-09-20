import fs from 'node:fs';
import path from 'node:path';

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * The Docker E2E image is Linux. A direct native CLI or wrapper may own the
 * returned PID while the actual process opens SQLite, so walk its /proc child
 * tree and inspect open descriptors instead of relying on a tmux-first hook.
 */
export function processTreeHasOpenFile(rootPid: number, file: string): boolean {
  const target = path.resolve(file);
  const pending = [rootPid];
  const visited = new Set<number>();

  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);

    let children: string;
    try {
      children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const value of children.trim().split(/\s+/)) {
      if (value) pending.push(Number(value));
    }

    let descriptors: string[];
    try {
      descriptors = fs.readdirSync(`/proc/${pid}/fd`);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const descriptor of descriptors) {
      let opened: string;
      try {
        opened = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`);
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      if (opened === target) return true;
    }
  }
  return false;
}
