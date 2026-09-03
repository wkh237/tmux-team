// ─────────────────────────────────────────────────────────────
// Pure tmux wrapper - buffer paste, capture-pane, pane detection
// ─────────────────────────────────────────────────────────────

import { execFileSync, execSync } from 'child_process';
import crypto from 'crypto';
import type {
  AgentRegistration,
  PaneAgentMetadata,
  Tmux,
  PaneInfo,
  RegistryScope,
  TmuxRegistry,
} from './types.js';
import { normalizeName } from './domain/service.js';

const AGENT_METADATA_OPTION = '@tmux-team.agent';
const PANE_FIELD_SEPARATOR = '__TMT_FIELD_4f1c__';

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

export function createTmux(): Tmux {
  function sleepMs(ms: number): void {
    if (ms <= 0) return;
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, ms);
  }

  function ensureTrailingNewline(message: string): string {
    return message.endsWith('\n') ? message : `${message}\n`;
  }

  function escapeExclamation(message: string): string {
    // Replace "!" with fullwidth "！" (U+FF01) to avoid shell history expansion
    return message.replace(/!/g, '\uff01');
  }

  function makeBufferName(): string {
    const nonce = crypto.randomBytes(4).toString('hex');
    return `tmt-${process.pid}-${Date.now()}-${nonce}`;
  }

  return {
    send(paneId: string, message: string, options?: { enterDelayMs?: number }): void {
      const enterDelayMs = Math.max(0, options?.enterDelayMs ?? 500);
      const bufferName = makeBufferName();
      const escaped = escapeExclamation(message);
      const payload = ensureTrailingNewline(escaped);

      try {
        execFileSync('tmux', ['set-buffer', '-b', bufferName, '--', payload], {
          stdio: 'pipe',
        });
        execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-d', '-t', paneId, '-p'], {
          stdio: 'pipe',
        });
        sleepMs(enterDelayMs);
        execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter'], {
          stdio: 'pipe',
        });
      } catch {
        // Fallback to legacy send-keys if buffer/paste fails
        execFileSync('tmux', ['send-keys', '-t', paneId, message], {
          stdio: 'pipe',
        });
        execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter'], {
          stdio: 'pipe',
        });
      }
    },

    capture(paneId: string, lines: number): string {
      const output = execSync(`tmux capture-pane -t "${paneId}" -p -S -${lines}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output;
    },

    listPanes(): PaneInfo[] {
      try {
        // Get all panes with stable IDs, human tmux targets, cwd, commands, and tmux-team metadata.
        const output = execSync(
          `tmux list-panes -a -F "#{pane_id}${PANE_FIELD_SEPARATOR}#{session_name}:#{window_index}.#{pane_index}${PANE_FIELD_SEPARATOR}#{pane_current_path}${PANE_FIELD_SEPARATOR}#{pane_current_command}${PANE_FIELD_SEPARATOR}#{${AGENT_METADATA_OPTION}}"`,
          {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );

        const seen = new Set<string>();
        return output
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            const fields = line.includes(PANE_FIELD_SEPARATOR)
              ? line.split(PANE_FIELD_SEPARATOR)
              : line.split('\t');
            const [id, target, cwd, command, metadataText] = line.includes(PANE_FIELD_SEPARATOR)
              ? [
                  fields[0],
                  fields[1],
                  fields[2],
                  fields[3],
                  fields.slice(4).join(PANE_FIELD_SEPARATOR),
                ]
              : fields.length >= 5
                ? fields
                : [fields[0], undefined, undefined, fields[1] ?? '', fields[2] ?? ''];
            // tmux 3.3 does not reliably expand pane user options inside
            // list-panes formats. Prefer the inline value on newer versions,
            // then fall back to the pane-scoped option without consulting any
            // legacy registry.
            const metadata = safeParseMetadata(metadataText) ?? tryReadPaneMetadata(id || '');
            return {
              id: id || '',
              ...(target && { target }),
              ...(cwd && { cwd }),
              command: command || '',
              suggestedName: detectAgentName(command || ''),
              ...(metadata && { metadata }),
            };
          })
          .filter((pane) => {
            if (!pane.id || seen.has(pane.id)) return false;
            seen.add(pane.id);
            return true;
          });
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
      // First check environment variable
      if (process.env.TMUX_PANE) {
        return process.env.TMUX_PANE;
      }

      // Fall back to tmux command
      try {
        const output = execSync('tmux display-message -p "#{pane_id}"', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output.trim() || null;
      } catch {
        return null;
      }
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
  };
}

function tryReadPaneMetadata(paneId: string): PaneAgentMetadata | undefined {
  if (!paneId) return undefined;
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

function readPaneMetadata(paneId: string): PaneAgentMetadata {
  return tryReadPaneMetadata(paneId) ?? emptyMetadata();
}

function writePaneMetadata(paneId: string, metadata: PaneAgentMetadata): void {
  if (!hasRegistrations(metadata)) {
    execFileSync('tmux', ['set-option', '-p', '-u', '-t', paneId, AGENT_METADATA_OPTION], {
      stdio: 'pipe',
    });
    return;
  }

  execFileSync(
    'tmux',
    ['set-option', '-p', '-t', paneId, AGENT_METADATA_OPTION, JSON.stringify(metadata)],
    {
      stdio: 'pipe',
    }
  );
}
