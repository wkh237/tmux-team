// ─────────────────────────────────────────────────────────────
// External tmux adapter - message delivery, capture, and pane detection
// ─────────────────────────────────────────────────────────────

import { execFileSync, execSync } from 'child_process';
import crypto from 'crypto';
import { performance } from 'node:perf_hooks';
import type {
  AgentRegistration,
  PaneAgentMetadata,
  Tmux,
  PaneInfo,
  RegistryScope,
  TmuxRegistry,
  TmuxEndpointProbe,
  TmuxEndpointSnapshot,
  TmuxOperationOptions,
} from './types.js';
import { normalizeName } from './domain/service.js';
import { sendTmuxMessage } from './tmux-message.js';

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

function registrationForScope(
  metadata: PaneAgentMetadata | undefined,
  scope: RegistryScope
): AgentRegistration | undefined {
  return metadata?.workspaces?.[scope.workspaceRoot];
}

function setRegistrationForScope(
  metadata: PaneAgentMetadata,
  scope: RegistryScope,
  registration: AgentRegistration
): PaneAgentMetadata {
  metadata.workspaces = {
    ...metadata.workspaces,
    [scope.workspaceRoot]: registration,
  };
  return metadata;
}

function deleteRegistrationForScope(
  metadata: PaneAgentMetadata,
  scope: RegistryScope
): AgentRegistration | undefined {
  const removed = metadata.workspaces?.[scope.workspaceRoot];
  if (metadata.workspaces) {
    delete metadata.workspaces[scope.workspaceRoot];
    if (Object.keys(metadata.workspaces).length === 0) delete metadata.workspaces;
  }
  return removed;
}

function hasRegistrations(metadata: PaneAgentMetadata): boolean {
  return Boolean(
    metadata.globalIdentity ||
    (metadata.workspaces && Object.keys(metadata.workspaces).length > 0) ||
    (metadata.teams && Object.keys(metadata.teams).length > 0)
  );
}

function registryFromPanes(panes: PaneInfo[], scope: RegistryScope): TmuxRegistry {
  const paneRegistry: TmuxRegistry['paneRegistry'] = {};
  const agents: TmuxRegistry['agents'] = {};

  for (const pane of panes) {
    const registration = registrationForScope(pane.metadata, scope);
    if (!registration || paneRegistry[registration.name]) {
      continue;
    }

    paneRegistry[registration.name] = {
      pane: pane.id,
      ...(registration.remark !== undefined && { remark: registration.remark }),
      ...(registration.preamble !== undefined && { preamble: registration.preamble }),
      ...(registration.deny !== undefined && { deny: registration.deny }),
    };

    if (
      Object.prototype.hasOwnProperty.call(registration, 'preamble') ||
      Object.prototype.hasOwnProperty.call(registration, 'deny')
    ) {
      agents[registration.name] = {
        ...(Object.prototype.hasOwnProperty.call(registration, 'preamble') && {
          preamble: registration.preamble,
        }),
        ...(Object.prototype.hasOwnProperty.call(registration, 'deny') && {
          deny: registration.deny,
        }),
      };
    }
  }

  return { paneRegistry, agents };
}

function parsePaneOutput(
  output: string,
  allowMetadataFallback = true,
  metadataOptions: TmuxOperationOptions & { readonly strictFallback?: boolean } = {}
): PaneInfo[] {
  const seen = new Set<string>();
  return output
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const fields = line.includes(PANE_FIELD_SEPARATOR)
        ? line.split(PANE_FIELD_SEPARATOR)
        : line.split('\t');
      const [id, target, cwd, command, panePidText, metadataText] =
        fields.length >= 6
          ? [
              fields[0],
              fields[1],
              fields[2],
              fields[3],
              fields[4],
              line.includes(PANE_FIELD_SEPARATOR)
                ? fields.slice(5).join(PANE_FIELD_SEPARATOR)
                : fields[5],
            ]
          : fields.length >= 5
            ? [fields[0], fields[1], fields[2], fields[3], undefined, fields[4]]
            : [fields[0], undefined, undefined, fields[1] ?? '', undefined, fields[2] ?? ''];
      // tmux 3.3 may omit pane user options in list formats. The fallback is
      // conservative because all independent evidence must still agree.
      const metadata =
        safeParseMetadata(metadataText) ??
        (allowMetadataFallback ? tryReadPaneMetadata(id || '', metadataOptions) : undefined);
      return {
        id: id || '',
        ...(target && { target }),
        ...(cwd && { cwd }),
        command: command || '',
        ...(panePidText &&
          Number.isInteger(Number(panePidText)) && { panePid: Number(panePidText) }),
        suggestedName: detectAgentName(command || ''),
        ...(metadata && { metadata }),
      };
    })
    .filter((pane) => {
      if (!pane.id || seen.has(pane.id)) return false;
      seen.add(pane.id);
      return true;
    });
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
    `#{${AGENT_METADATA_OPTION}}`,
  ].join(PANE_FIELD_SEPARATOR);
}

function parseEndpointSnapshot(
  output: string,
  options: {
    readonly expectedServerId?: string;
    readonly allowMetadataFallback: boolean;
    readonly metadataOptions?: TmuxOperationOptions & { readonly strictFallback?: boolean };
    readonly requireCompleteEvidence?: boolean;
  }
): TmuxEndpointSnapshot {
  const rows = output.split('\n').filter((line) => line.trim());
  if (rows.length === 0) throw new Error('tmux endpoint snapshot is empty');

  const evidence = rows.map((line) => line.split(PANE_FIELD_SEPARATOR).slice(0, 4));
  const [serverId = '', socketPath, serverPidText, serverStartTime] = evidence[0] ?? [];
  const serverPid = Number(serverPidText);
  const completeEvidence = rows.every((line) => line.split(PANE_FIELD_SEPARATOR).length >= 10);
  if (
    (options.expectedServerId !== undefined && serverId !== options.expectedServerId) ||
    (options.requireCompleteEvidence && (!SERVER_ID_PATTERN.test(serverId) || !completeEvidence)) ||
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

  const paneOutput = rows
    .map((line) => line.split(PANE_FIELD_SEPARATOR).slice(4).join(PANE_FIELD_SEPARATOR))
    .join('\n');
  const panes = parsePaneOutput(paneOutput, options.allowMetadataFallback, options.metadataOptions);
  if (
    options.requireCompleteEvidence &&
    (panes.length !== rows.length ||
      panes.some(
        (pane) =>
          !/^%\d+$/.test(pane.id) ||
          typeof pane.panePid !== 'number' ||
          !Number.isSafeInteger(pane.panePid) ||
          pane.panePid <= 0
      ))
  ) {
    throw new Error('tmux endpoint snapshot contains incomplete pane evidence');
  }
  return {
    server: { serverId, socketPath, serverPid, serverStartTime },
    panes,
  };
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

function callerTmuxContext(
  value: string | undefined
):
  | { readonly socketPath: string; readonly serverPid: number; readonly sessionId: string }
  | undefined {
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
  if (!paneId || !PANE_ID_PATTERN.test(paneId)) return null;
  const context = callerTmuxContext(process.env.TMUX);
  if (!context) return null;

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

  let output: string;
  try {
    output = execFileSync('tmux', ['-S', socketPath, 'list-panes', '-a', '-F', endpointFormat()], {
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
    const snapshot = parseEndpointSnapshot(output, {
      allowMetadataFallback: false,
      requireCompleteEvidence: true,
    });
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
          `tmux list-panes -a -F "#{pane_id}${PANE_FIELD_SEPARATOR}#{session_name}:#{window_index}.#{pane_index}${PANE_FIELD_SEPARATOR}#{pane_current_path}${PANE_FIELD_SEPARATOR}#{pane_current_command}${PANE_FIELD_SEPARATOR}#{pane_pid}${PANE_FIELD_SEPARATOR}#{${AGENT_METADATA_OPTION}}"`,
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

    setPaneTitle(paneId: string, title: string): void {
      execFileSync('tmux', ['select-pane', '-t', paneId, '-T', title], { stdio: 'pipe' });
      // Keep the title visible in the pane border and let tmux inherit the
      // active/inactive border colors from the user's theme.
      execFileSync('tmux', ['set-window-option', '-t', paneId, 'pane-border-status', 'top'], {
        stdio: 'pipe',
      });
      execFileSync(
        'tmux',
        ['set-window-option', '-t', paneId, 'pane-border-format', '#[align=right]#{pane_title}'],
        { stdio: 'pipe' }
      );
    },

    getCurrentPaneId(): string | null {
      // Implicit commands may select only a pane proven by the caller's tmux
      // environment. Never fall back to the ambient/default server.
      return callerPaneId();
    },

    getAgentRegistry(scope: RegistryScope): TmuxRegistry {
      return registryFromPanes(this.listPanes(), scope);
    },

    setAgentRegistration(
      paneId: string,
      scope: RegistryScope,
      registration: AgentRegistration
    ): void {
      const metadata = readPaneMetadata(paneId);
      const next = setRegistrationForScope(metadata, scope, registration);
      writePaneMetadata(paneId, next);
    },

    clearAgentRegistration(name: string, scope: RegistryScope): boolean {
      let removed = false;
      for (const pane of this.listPanes()) {
        const registration = registrationForScope(pane.metadata, scope);
        if (registration?.name !== name) continue;

        const metadata = pane.metadata ?? emptyMetadata();
        deleteRegistrationForScope(metadata, scope);
        writePaneMetadata(pane.id, metadata);
        removed = true;
      }
      return removed;
    },

    listGlobalIdentities() {
      return this.listPanes().flatMap((pane) => {
        const identity = pane.metadata?.globalIdentity;
        if (!identity || typeof identity.name !== 'string') return [];
        return [
          {
            name: identity.name,
            canonicalName:
              typeof identity.canonicalName === 'string' && identity.canonicalName
                ? identity.canonicalName
                : normalizeName(identity.name),
            paneId: pane.id,
          },
        ];
      });
    },

    setGlobalIdentity(paneId: string, name: string): void {
      const metadata = readPaneMetadata(paneId);
      metadata.globalIdentity = { name, canonicalName: normalizeName(name) };
      writePaneMetadata(paneId, metadata);
    },

    clearGlobalIdentity(paneId: string): boolean {
      const metadata = readPaneMetadata(paneId);
      if (!metadata.globalIdentity) return false;
      delete metadata.globalIdentity;
      writePaneMetadata(paneId, metadata);
      return true;
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
  const expectedServerId = ensureServerId(options);
  const output = execFileSync('tmux', ['list-panes', '-a', '-F', endpointFormat()], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...commandOptions(options),
  });
  return parseEndpointSnapshot(output, {
    expectedServerId,
    allowMetadataFallback: true,
    metadataOptions: { ...options, strictFallback: true },
  });
}

function tryReadPaneMetadata(
  paneId: string,
  options: TmuxOperationOptions & { readonly strictFallback?: boolean } = {}
): PaneAgentMetadata | undefined {
  if (!paneId) return undefined;
  if (options.strictFallback) {
    return readPaneMetadataStrict(paneId, options);
  }
  try {
    const output = execFileSync(
      'tmux',
      ['show-options', '-p', '-t', paneId, '-v', AGENT_METADATA_OPTION],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return safeParseMetadata(output);
  } catch {
    return undefined;
  }
}

function readPaneMetadataStrict(
  paneId: string,
  options: TmuxOperationOptions = {}
): PaneAgentMetadata {
  const output = execFileSync(
    'tmux',
    ['show-options', '-q', '-p', '-t', paneId, '-v', AGENT_METADATA_OPTION],
    {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...commandOptions(options),
    }
  );
  return safeParseMetadata(output) ?? emptyMetadata();
}

function readPaneMetadata(paneId: string): PaneAgentMetadata {
  return tryReadPaneMetadata(paneId) ?? emptyMetadata();
}

function writePaneMetadata(
  paneId: string,
  metadata: PaneAgentMetadata,
  options: TmuxOperationOptions = {}
): void {
  if (!hasRegistrations(metadata)) {
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
}
