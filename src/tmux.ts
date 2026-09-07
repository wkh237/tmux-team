// ─────────────────────────────────────────────────────────────
// External tmux adapter - message delivery, capture, and pane detection
// ─────────────────────────────────────────────────────────────

import { execFileSync, execSync } from 'child_process';
import crypto from 'crypto';
import { performance } from 'node:perf_hooks';
import type {
  PaneAgentMetadata,
  Tmux,
  PaneInfo,
  TmuxEndpointProbe,
  TmuxEndpointSnapshot,
  TmuxServerEvidence,
  TmuxOperationOptions,
} from './types.js';
import { sendTmuxMessage } from './tmux-message.js';
import { PaneMetadataError } from './pane-metadata-error.js';

const AGENT_METADATA_OPTION = '@tmux-team.agent';
const SERVER_ID_OPTION = '@tmux-team.server-id';
const PANE_FIELD_SEPARATOR = '__TMT_FIELD_4f1c__';
const ENDPOINT_PROBE_TIMEOUT_MS = 1_000;
const ENDPOINT_PROBE_MAX_BUFFER = 1024 * 1024;
const TMUX_OPERATION_TIMEOUT_MS = 1_000;
const TMUX_CAPTURE_TIMEOUT_MS = 1_000;
const TMUX_CAPTURE_MAX_BUFFER = 4 * 1024 * 1024;
const CALLER_PANE_TIMEOUT_MS = 1_000;
const CALLER_PANE_MAX_BUFFER = 4096;
const CALLER_PANE_SEPARATOR = '__TMT_CALLER_PANE_4f1c__';
const CALLER_ANCESTRY_MAX_DEPTH = 64;
const CALLER_DISCOVERY_MAX_BUFFER = 64 * 1024;
const SERVER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PANE_ID_PATTERN = /^%\d+$/;

// Known agent patterns for auto-detection
const KNOWN_AGENTS: Record<string, string[]> = {
  claude: ['claude', 'claude-code'],
  codex: ['codex'],
  gemini: ['gemini'],
  aider: ['aider'],
  cursor: ['cursor'],
};

function detectAgentName(command: string): string | null {
  const lowerCommand = command.toLowerCase();
  for (const [agentName, patterns] of Object.entries(KNOWN_AGENTS)) {
    for (const pattern of patterns) {
      if (lowerCommand.includes(pattern)) {
        return agentName;
      }
    }
  }
  return null;
}

function safeParseMetadata(text: string): PaneAgentMetadata | undefined {
  if (!text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as PaneAgentMetadata;
    if (!parsed || parsed.version !== 1 || typeof parsed !== 'object') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function emptyMetadata(): PaneAgentMetadata {
  return { version: 1 };
}

interface ParsedPaneRow {
  readonly pane: PaneInfo;
  readonly attached: boolean;
}

function parsePaneRow(line: string): ParsedPaneRow {
  const fields = line.includes(PANE_FIELD_SEPARATOR)
    ? line.split(PANE_FIELD_SEPARATOR)
    : line.split('\t');
  const withAttachment = fields.length >= 7;
  const modern = fields.length >= 6;
  const [id, target, cwd, command, panePidText, sessionAttachedText, metadataText] = withAttachment
    ? [
        fields[0],
        fields[1],
        fields[2],
        fields[3],
        fields[4],
        fields[5],
        line.includes(PANE_FIELD_SEPARATOR)
          ? fields.slice(6).join(PANE_FIELD_SEPARATOR)
          : fields[6],
      ]
    : modern
      ? [
          fields[0],
          fields[1],
          fields[2],
          fields[3],
          fields[4],
          undefined,
          line.includes(PANE_FIELD_SEPARATOR)
            ? fields.slice(5).join(PANE_FIELD_SEPARATOR)
            : fields[5],
        ]
      : fields.length >= 5
        ? [fields[0], fields[1], fields[2], fields[3], undefined, undefined, fields[4]]
        : [fields[0], undefined, undefined, fields[1] ?? '', undefined, undefined, fields[2] ?? ''];
  // User options are expanded in the same list-panes batch as the pane
  // evidence. A missing or malformed value is simply absent metadata;
  // querying each pane here would turn an unbound server into O(panes)
  // subprocesses.
  const metadata = safeParseMetadata(metadataText);
  return {
    pane: {
      id: id || '',
      ...(target && { target }),
      ...(cwd && { cwd }),
      command: command || '',
      ...(panePidText && Number.isInteger(Number(panePidText)) && { panePid: Number(panePidText) }),
      suggestedName: detectAgentName(command || ''),
      ...(metadata && { metadata }),
    },
    attached: Number.isInteger(Number(sessionAttachedText)) && Number(sessionAttachedText) > 0,
  };
}

function parsePaneOutput(output: string): PaneInfo[] {
  const seen = new Map<string, ParsedPaneRow>();
  output
    .split('\n')
    .filter((line) => line.trim())
    .map(parsePaneRow)
    .forEach((row) => {
      if (!row.pane.id) return;
      const previous = seen.get(row.pane.id);
      // Grouped sessions and linked windows repeat pane IDs with different
      // presentation targets. Prefer an attached session's presentation, but
      // retain first-seen order for ties and when all rows are detached.
      if (!previous || (row.attached && !previous.attached)) seen.set(row.pane.id, row);
    });
  return [...seen.values()].map(({ pane }) => pane);
}

function endpointFormat(): string {
  return [
    `#{${SERVER_ID_OPTION}}`,
    '#{socket_path}',
    '#{pid}',
    '#{start_time}',
    '#{pane_id}',
    '#{session_name}:#{window_index}.#{pane_index}',
    '#{pane_current_path}',
    '#{pane_current_command}',
    '#{pane_pid}',
    '#{session_attached}',
    `#{${AGENT_METADATA_OPTION}}`,
  ].join(PANE_FIELD_SEPARATOR);
}

function serverFormat(): string {
  return [`#{${SERVER_ID_OPTION}}`, '#{socket_path}', '#{pid}', '#{start_time}'].join(
    PANE_FIELD_SEPARATOR
  );
}

function scopedPaneIds(options: TmuxOperationOptions): string[] | undefined {
  if (options.paneIds === undefined) return undefined;
  const paneIds = [...new Set(options.paneIds)];
  if (paneIds.some((paneId) => !PANE_ID_PATTERN.test(paneId))) {
    throw new Error('tmux pane scope contains an invalid pane ID');
  }
  return paneIds;
}

function paneFilter(paneIds: readonly string[]): string {
  const expressions = paneIds.map((paneId) => `#{==:#{pane_id},${paneId}}`);
  const first = expressions[0];
  if (!first) throw new Error('A pane filter requires at least one valid pane ID.');
  return expressions
    .slice(1)
    .reduce((combined, expression) => `#{||:${combined},${expression}}`, first);
}

function parseServerEvidence(output: string, expectedServerId?: string): TmuxServerEvidence {
  const rows = output.split('\n').filter((line) => line.trim());
  if (rows.length === 0) throw new Error('tmux server evidence is empty');
  const evidence = rows.map((line) => line.split(PANE_FIELD_SEPARATOR));
  const [serverId = '', socketPath, serverPidText, serverStartTime] = evidence[0] ?? [];
  const serverPid = Number(serverPidText);
  if (
    (expectedServerId !== undefined && serverId !== expectedServerId) ||
    !SERVER_ID_PATTERN.test(serverId) ||
    !socketPath ||
    !serverStartTime ||
    !Number.isSafeInteger(serverPid) ||
    serverPid <= 0 ||
    evidence.some(
      ([id, socket, pid, started]) =>
        id !== serverId ||
        socket !== socketPath ||
        pid !== serverPidText ||
        started !== serverStartTime
    )
  ) {
    throw new Error('tmux endpoint snapshot contains inconsistent server evidence');
  }
  return { serverId, socketPath, serverPid, serverStartTime };
}

function endpointListArgs(options: TmuxOperationOptions, socketPath?: string): string[] {
  const args = socketPath ? ['-S', socketPath] : [];
  args.push('list-panes', '-a');
  const paneIds = scopedPaneIds(options);
  if (paneIds !== undefined && paneIds.length > 0) args.push('-f', paneFilter(paneIds));
  args.push('-F', endpointFormat());
  return args;
}

function serverEvidenceArgs(socketPath?: string): string[] {
  const args = socketPath ? ['-S', socketPath] : [];
  args.push('display-message', '-p', serverFormat());
  return args;
}

function readServerEvidence(
  options: TmuxOperationOptions,
  socketPath: string | undefined,
  expectedServerId?: string
): TmuxServerEvidence {
  const output = execFileSync('tmux', serverEvidenceArgs(socketPath), {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...commandOptions(options),
  });
  return parseServerEvidence(output, expectedServerId);
}

function parseEndpointSnapshot(
  output: string,
  options: {
    readonly expectedServerId?: string;
    readonly requireCompleteEvidence?: boolean;
  }
): TmuxEndpointSnapshot {
  const rows = output.split('\n').filter((line) => line.trim());
  if (rows.length === 0) throw new Error('tmux endpoint snapshot is empty');

  const server = parseServerEvidence(output, options.expectedServerId);
  const evidence = rows.map((line) => line.split(PANE_FIELD_SEPARATOR));
  const completeEvidence = evidence.every((fields) => fields.length >= 11);
  if (options.requireCompleteEvidence && !completeEvidence) {
    throw new Error('tmux endpoint snapshot contains inconsistent server evidence');
  }

  if (options.requireCompleteEvidence) {
    const seen = new Map<string, { panePid: number; metadata: string }>();
    for (const fields of evidence) {
      const paneId = fields[4] ?? '';
      const panePid = Number(fields[8]);
      if (!PANE_ID_PATTERN.test(paneId) || !Number.isSafeInteger(panePid) || panePid <= 0) {
        throw new Error('tmux endpoint snapshot contains incomplete pane evidence');
      }
      const metadata = fields.slice(10).join(PANE_FIELD_SEPARATOR);
      const previous = seen.get(paneId);
      // Grouped sessions and linked windows repeat panes with different display
      // targets. Validate every row before deduplication so a later malformed
      // or contradictory process/metadata observation cannot disappear.
      if (previous && (previous.panePid !== panePid || previous.metadata !== metadata)) {
        throw new Error('tmux endpoint snapshot contains conflicting pane evidence');
      }
      seen.set(paneId, { panePid, metadata });
    }
  }
  const paneOutput = evidence
    .map((fields) => fields.slice(4).join(PANE_FIELD_SEPARATOR))
    .join('\n');
  const panes = parsePaneOutput(paneOutput);
  return {
    server,
    panes,
  };
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

interface CallerTmuxContext {
  readonly socketPath: string;
  readonly serverPid: number;
  readonly sessionId: string;
}

function callerTmuxContext(value: string | undefined): CallerTmuxContext | undefined {
  if (!value) return undefined;
  const lastComma = value.lastIndexOf(',');
  const previousComma = value.lastIndexOf(',', lastComma - 1);
  if (previousComma <= 0 || lastComma <= previousComma + 1 || lastComma === value.length - 1) {
    return undefined;
  }
  const socketPath = value.slice(0, previousComma);
  const serverPidText = value.slice(previousComma + 1, lastComma);
  const sessionId = value.slice(lastComma + 1);
  if (!socketPath || !/^\d+$/.test(serverPidText) || !/^\d+$/.test(sessionId)) {
    return undefined;
  }
  const serverPid = Number(serverPidText);
  if (!Number.isSafeInteger(serverPid) || serverPid <= 0) return undefined;
  return { socketPath, serverPid, sessionId };
}

function callerPaneId(): string | null {
  const paneId = process.env.TMUX_PANE;
  const tmuxValue = process.env.TMUX;
  if (paneId && !PANE_ID_PATTERN.test(paneId)) return null;
  const context = callerTmuxContext(tmuxValue);
  if (tmuxValue && !context) return null;

  // Keep the fully populated environment as the cheap, strict path. In
  // particular, do not let discovery hide stale or mismatched explicit
  // evidence.
  if (paneId && context) return verifyCallerPane(paneId, context);
  return discoverCallerPane(paneId || undefined, context);
}

function callerCommandOptions(timeout: number): {
  timeout: number;
  maxBuffer: number;
  killSignal: 'SIGKILL';
} {
  return {
    timeout,
    maxBuffer: CALLER_DISCOVERY_MAX_BUFFER,
    killSignal: 'SIGKILL',
  };
}

function verifyCallerPane(paneId: string, context: CallerTmuxContext): string | null {
  try {
    const output = execFileSync(
      'tmux',
      [
        'display-message',
        '-p',
        '-t',
        paneId,
        `#{pane_id}${CALLER_PANE_SEPARATOR}#{socket_path}${CALLER_PANE_SEPARATOR}#{pid}`,
      ],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: CALLER_PANE_TIMEOUT_MS,
        maxBuffer: CALLER_PANE_MAX_BUFFER,
        killSignal: 'SIGKILL',
      }
    );
    const text = output.trim();
    if (!text || text.includes('\n')) return null;
    const fields = text.split(CALLER_PANE_SEPARATOR);
    if (fields.length !== 3) return null;
    const [returnedPaneId, returnedSocketPath, returnedServerPid] = fields;
    if (
      returnedPaneId !== paneId ||
      returnedSocketPath !== context.socketPath ||
      returnedServerPid !== String(context.serverPid)
    ) {
      return null;
    }
    return paneId;
  } catch {
    return null;
  }
}

function callerAncestry(deadline: number): Set<number> | null {
  const ancestry = new Set<number>();
  let pid = process.pid;
  for (let depth = 0; depth < CALLER_ANCESTRY_MAX_DEPTH; depth += 1) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || ancestry.has(pid)) return null;
    ancestry.add(pid);
    let output: string;
    try {
      const timeout = Math.floor(deadline - performance.now());
      if (timeout <= 0) return null;
      output = execFileSync('ps', ['-o', 'pid=,ppid=', '-p', String(pid)], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...callerCommandOptions(timeout),
      });
    } catch {
      return null;
    }
    if (typeof output !== 'string') return null;
    const rows = output
      .trim()
      .split(/\r?\n/)
      .map((row) => row.trim().split(/\s+/))
      .filter((row) => row.length > 0);
    if (
      rows.length !== 1 ||
      rows[0]?.length !== 2 ||
      !/^\d+$/.test(rows[0][0] ?? '') ||
      !/^\d+$/.test(rows[0][1] ?? '')
    ) {
      return null;
    }
    const returnedPid = Number(rows[0][0]);
    const parentPid = Number(rows[0][1]);
    if (returnedPid !== pid || !Number.isSafeInteger(parentPid) || parentPid < 0) return null;
    if (parentPid === 0) return ancestry;
    pid = parentPid;
  }
  return null;
}

function discoverCallerPane(
  paneId: string | undefined,
  context: CallerTmuxContext | undefined
): string | null {
  const deadline = performance.now() + CALLER_PANE_TIMEOUT_MS;
  const ancestry = callerAncestry(deadline);
  if (!ancestry) return null;
  const format = `#{pane_id}${CALLER_PANE_SEPARATOR}#{pane_pid}${CALLER_PANE_SEPARATOR}#{socket_path}${CALLER_PANE_SEPARATOR}#{pid}`;
  let output: string;
  try {
    const timeout = Math.floor(deadline - performance.now());
    if (timeout <= 0) return null;
    const args = context
      ? ['-S', context.socketPath, 'list-panes', '-a', '-F', format]
      : ['list-panes', '-a', '-F', format];
    output = execFileSync('tmux', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...callerCommandOptions(timeout),
    });
  } catch {
    return null;
  }
  if (performance.now() >= deadline) return null;
  if (typeof output !== 'string') return null;
  const rows = output.trim().split(/\r?\n/).filter(Boolean);
  if (rows.length === 0) return null;
  const parsedRows = rows.map((row) => row.split(CALLER_PANE_SEPARATOR));
  if (
    parsedRows.some((fields) => fields.length !== 4) ||
    parsedRows.some(([id, panePid, socketPath, serverPid]) => {
      const numericPanePid = Number(panePid);
      const numericServerPid = Number(serverPid);
      return (
        !id ||
        !PANE_ID_PATTERN.test(id) ||
        !/^\d+$/.test(panePid ?? '') ||
        !Number.isSafeInteger(numericPanePid) ||
        numericPanePid <= 0 ||
        !socketPath ||
        !/^\d+$/.test(serverPid ?? '') ||
        !Number.isSafeInteger(numericServerPid) ||
        numericServerPid <= 0
      );
    })
  )
    return null;
  const uniqueRows = new Map<string, string[]>();
  for (const fields of parsedRows) {
    const id = fields[0]!; // The shape and ID were validated above.
    const previous = uniqueRows.get(id);
    if (previous && fields.some((field, index) => field !== previous[index])) return null;
    uniqueRows.set(id, fields);
  }
  const candidates = [...uniqueRows.values()]
    .filter(([id, panePid, socketPath, serverPid]) => {
      const numericPanePid = Number(panePid);
      if (!ancestry.has(numericPanePid)) return false;
      if (context && (socketPath !== context.socketPath || serverPid !== String(context.serverPid)))
        return false;
      return paneId === undefined || id === paneId;
    })
    .map(([id]) => id);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function remainingTimeout(options: TmuxOperationOptions = {}): number {
  const remaining =
    options.deadlineMs === undefined
      ? TMUX_OPERATION_TIMEOUT_MS
      : options.deadlineMs - performance.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error('tmux operation deadline exceeded');
  }
  return Math.max(1, Math.min(TMUX_OPERATION_TIMEOUT_MS, Math.floor(remaining)));
}

function commandOptions(options: TmuxOperationOptions = {}): {
  timeout: number;
  maxBuffer: number;
  killSignal: 'SIGKILL';
} {
  return {
    timeout: remainingTimeout(options),
    maxBuffer: ENDPOINT_PROBE_MAX_BUFFER,
    killSignal: 'SIGKILL',
  };
}

function probeEndpoint(
  socketPath: string,
  serverPid: number,
  options: TmuxOperationOptions = {}
): TmuxEndpointProbe {
  if (!socketPath || !Number.isSafeInteger(serverPid) || serverPid <= 0) {
    return { status: 'unknown' };
  }

  let paneIds: string[] | undefined;
  try {
    paneIds = scopedPaneIds(options);
  } catch {
    return { status: 'unknown' };
  }

  let output: string;
  try {
    if (paneIds !== undefined && paneIds.length === 0) {
      const snapshot = { server: readServerEvidence(options, socketPath), panes: [] };
      return snapshot.server.socketPath === socketPath
        ? { status: 'live', snapshot }
        : { status: 'unknown' };
    }
    output = execFileSync('tmux', endpointListArgs(options, socketPath), {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: Math.min(ENDPOINT_PROBE_TIMEOUT_MS, remainingTimeout(options)),
      maxBuffer: ENDPOINT_PROBE_MAX_BUFFER,
      killSignal: 'SIGKILL',
    });
  } catch {
    try {
      process.kill(serverPid, 0);
    } catch (signalError) {
      if (isMissingProcess(signalError)) return { status: 'dead' };
    }
    return { status: 'unknown' };
  }

  try {
    let snapshot: TmuxEndpointSnapshot;
    if (output.trim()) {
      snapshot = parseEndpointSnapshot(output, { requireCompleteEvidence: true });
    } else if (paneIds !== undefined) {
      snapshot = { server: readServerEvidence(options, socketPath), panes: [] };
    } else {
      return { status: 'unknown' };
    }
    return snapshot.server.socketPath === socketPath
      ? { status: 'live', snapshot }
      : { status: 'unknown' };
  } catch {
    return { status: 'unknown' };
  }
}

export function createTmux(): Tmux {
  return {
    send(paneId: string, message: string, options?: { enterDelayMs?: number }): void {
      const enterDelayMs = Math.max(0, options?.enterDelayMs ?? 500);
      sendTmuxMessage({
        paneId,
        message,
        enterDelayMs,
        execute: (args, commandOptions) => execFileSync('tmux', args, commandOptions),
        sleep: (ms) => {
          if (ms <= 0) return;
          const buffer = new SharedArrayBuffer(4);
          const view = new Int32Array(buffer);
          Atomics.wait(view, 0, 0, ms);
        },
      });
    },

    capture(paneId: string, lines: number): string {
      const output = execFileSync('tmux', ['capture-pane', '-t', paneId, '-p', '-S', `-${lines}`], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: TMUX_CAPTURE_TIMEOUT_MS,
        maxBuffer: TMUX_CAPTURE_MAX_BUFFER,
        killSignal: 'SIGKILL',
      });
      return output;
    },

    listPanes(): PaneInfo[] {
      try {
        // Get all panes with stable IDs, human tmux targets, cwd, commands, and tmux-team metadata.
        const output = execSync(
          `tmux list-panes -a -F "#{pane_id}${PANE_FIELD_SEPARATOR}#{session_name}:#{window_index}.#{pane_index}${PANE_FIELD_SEPARATOR}#{pane_current_path}${PANE_FIELD_SEPARATOR}#{pane_current_command}${PANE_FIELD_SEPARATOR}#{pane_pid}${PANE_FIELD_SEPARATOR}#{session_attached}${PANE_FIELD_SEPARATOR}#{${AGENT_METADATA_OPTION}}"`,
          {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );

        return parsePaneOutput(output);
      } catch {
        return [];
      }
    },

    resolvePaneTarget(target: string): string | null {
      try {
        const output = execFileSync('tmux', ['display-message', '-p', '-t', target, '#{pane_id}'], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output.trim() || null;
      } catch {
        return null;
      }
    },

    setPaneBadge(paneId: string, name: string | null): void {
      const args = ['set-option', '-p'];
      if (name === null) args.push('-u');
      args.push('-t', paneId, '@tmux-team.badge');
      if (name !== null) {
        // This is a bounded display label, never identity or executable format.
        // Replace format introducers and terminal controls rather than allowing
        // an identity name to inject tmux styling or nested command expansion.
        const characters = Array.from(name.replaceAll('#', '＃').replace(/\p{Cc}/gu, ' '));
        const label = characters.slice(0, 48).join('') + (characters.length > 48 ? '…' : '');
        args.push(`${label} (tmt)`);
      }
      execFileSync('tmux', args, { stdio: 'pipe', ...commandOptions() });
    },

    getCurrentPaneId(): string | null {
      // Select only verified environment or process-ancestry evidence, never
      // the ambient server's active pane.
      return callerPaneId();
    },

    getEndpointSnapshot(options) {
      return readEndpointSnapshot(options);
    },

    probeEndpoint,

    setDurableIdentity(paneId, identity, binding, options) {
      const metadata = readPaneMetadataStrict(paneId, options);
      metadata.globalIdentity = {
        name: identity.name,
        canonicalName: identity.canonicalName,
        identityId: identity.id,
        bindingId: binding.id,
        serverId: binding.serverId,
        panePid: binding.panePid,
      };
      writePaneMetadata(paneId, metadata, options);
    },

    clearDurableIdentity(paneId, bindingId, options) {
      const metadata = readPaneMetadataStrict(paneId, options);
      if (!metadata.globalIdentity) return false;
      if (bindingId && metadata.globalIdentity.bindingId !== bindingId) return false;
      delete metadata.globalIdentity;
      writePaneMetadata(paneId, metadata, options);
      return true;
    },
  };
}

function ensureServerId(options: TmuxOperationOptions = {}): string {
  let serverId = '';
  try {
    serverId = execFileSync('tmux', ['show-options', '-s', '-v', SERVER_ID_OPTION], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...commandOptions(options),
    }).trim();
  } catch {
    serverId = crypto.randomUUID();
    execFileSync('tmux', ['set-option', '-s', '-o', SERVER_ID_OPTION, serverId], {
      stdio: 'pipe',
      ...commandOptions(options),
    });
    serverId = execFileSync('tmux', ['show-options', '-s', '-v', SERVER_ID_OPTION], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...commandOptions(options),
    }).trim();
  }
  if (!SERVER_ID_PATTERN.test(serverId)) {
    throw new Error('tmux server identity is unavailable');
  }
  return serverId;
}

function readEndpointSnapshot(options: TmuxOperationOptions = {}) {
  const paneIds = scopedPaneIds(options);
  const expectedServerId = ensureServerId(options);
  if (paneIds !== undefined && paneIds.length === 0) {
    return { server: readServerEvidence(options, undefined, expectedServerId), panes: [] };
  }
  const output = execFileSync('tmux', endpointListArgs(options), {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...commandOptions(options),
  });
  if (output.trim()) {
    return parseEndpointSnapshot(output, { expectedServerId, requireCompleteEvidence: true });
  }
  if (paneIds === undefined) {
    throw new Error('tmux endpoint snapshot is empty');
  }
  return { server: readServerEvidence(options, undefined, expectedServerId), panes: [] };
}

function readPaneMetadataStrict(
  paneId: string,
  options: TmuxOperationOptions = {}
): PaneAgentMetadata {
  let output: string;
  try {
    output = execFileSync(
      'tmux',
      ['show-options', '-q', '-p', '-t', paneId, '-v', AGENT_METADATA_OPTION],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...commandOptions(options),
      }
    );
  } catch (cause) {
    throw new PaneMetadataError('read', { cause });
  }
  return safeParseMetadata(output) ?? emptyMetadata();
}

function hasMetadata(metadata: PaneAgentMetadata): boolean {
  return Object.keys(metadata).some((key) => key !== 'version');
}

function writePaneMetadata(
  paneId: string,
  metadata: PaneAgentMetadata,
  options: TmuxOperationOptions = {}
): void {
  try {
    if (!hasMetadata(metadata)) {
      execFileSync('tmux', ['set-option', '-p', '-u', '-t', paneId, AGENT_METADATA_OPTION], {
        stdio: 'pipe',
        ...commandOptions(options),
      });
      return;
    }

    execFileSync(
      'tmux',
      ['set-option', '-p', '-t', paneId, AGENT_METADATA_OPTION, JSON.stringify(metadata)],
      {
        stdio: 'pipe',
        ...commandOptions(options),
      }
    );
  } catch (cause) {
    throw new PaneMetadataError('write', { cause });
  }
}
