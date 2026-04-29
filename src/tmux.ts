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

const AGENT_METADATA_OPTION = '@tmux-team.agent';

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
  if (!metadata) return undefined;
  if (scope.type === 'team') {
    return metadata.teams?.[scope.teamName];
  }
  return metadata.workspaces?.[scope.workspaceRoot];
}

function setRegistrationForScope(
  metadata: PaneAgentMetadata,
  scope: RegistryScope,
  registration: AgentRegistration
): PaneAgentMetadata {
  if (scope.type === 'team') {
    metadata.teams = { ...metadata.teams, [scope.teamName]: registration };
  } else {
    metadata.workspaces = {
      ...metadata.workspaces,
      [scope.workspaceRoot]: registration,
    };
  }
  return metadata;
}

function deleteRegistrationForScope(
  metadata: PaneAgentMetadata,
  scope: RegistryScope
): AgentRegistration | undefined {
  let removed: AgentRegistration | undefined;
  if (scope.type === 'team') {
    removed = metadata.teams?.[scope.teamName];
    if (metadata.teams) {
      delete metadata.teams[scope.teamName];
      if (Object.keys(metadata.teams).length === 0) delete metadata.teams;
    }
  } else {
    removed = metadata.workspaces?.[scope.workspaceRoot];
    if (metadata.workspaces) {
      delete metadata.workspaces[scope.workspaceRoot];
      if (Object.keys(metadata.workspaces).length === 0) delete metadata.workspaces;
    }
  }
  return removed;
}

function hasRegistrations(metadata: PaneAgentMetadata): boolean {
  return Boolean(
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
        execSync(`tmux set-buffer -b "${bufferName}" -- ${JSON.stringify(payload)}`, {
          stdio: 'pipe',
        });
        execSync(`tmux paste-buffer -b "${bufferName}" -d -t "${paneId}" -p`, {
          stdio: 'pipe',
        });
        sleepMs(enterDelayMs);
        execSync(`tmux send-keys -t "${paneId}" Enter`, {
          stdio: 'pipe',
        });
      } catch {
        // Fallback to legacy send-keys if buffer/paste fails
        execSync(`tmux send-keys -t "${paneId}" ${JSON.stringify(message)}`, {
          stdio: 'pipe',
        });
        execSync(`tmux send-keys -t "${paneId}" Enter`, {
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
        // Get all panes with their IDs, current commands, and tmux-team metadata.
        const output = execSync(
          `tmux list-panes -a -F "#{pane_id}\t#{pane_current_command}\t#{${AGENT_METADATA_OPTION}}"`,
          {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );

        const seen = new Set<string>();
        return output
          .trim()
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            const [id, command, metadataText = ''] = line.split('\t');
            const metadata = safeParseMetadata(metadataText);
            return {
              id: id || '',
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

    listTeams(): Record<string, string[]> {
      const teams: Record<string, Set<string>> = {};
      for (const pane of this.listPanes()) {
        for (const [teamName, registration] of Object.entries(pane.metadata?.teams ?? {})) {
          if (!teams[teamName]) teams[teamName] = new Set<string>();
          teams[teamName].add(registration.name);
        }
      }
      return Object.fromEntries(
        Object.entries(teams).map(([teamName, agents]) => [teamName, [...agents].sort()])
      );
    },

    removeTeam(teamName: string): { removed: number; agents: string[] } {
      const agents = new Set<string>();
      let removed = 0;
      for (const pane of this.listPanes()) {
        if (!pane.metadata?.teams?.[teamName]) continue;

        agents.add(pane.metadata.teams[teamName].name);
        const metadata = pane.metadata;
        const teamRegistrations = metadata.teams;
        if (teamRegistrations) {
          delete teamRegistrations[teamName];
          if (Object.keys(teamRegistrations).length === 0) delete metadata.teams;
        }
        writePaneMetadata(pane.id, metadata);
        removed += 1;
      }
      return { removed, agents: [...agents].sort() };
    },
  };
}

function readPaneMetadata(paneId: string): PaneAgentMetadata {
  try {
    const output = execFileSync(
      'tmux',
      ['show-options', '-p', '-t', paneId, '-v', AGENT_METADATA_OPTION],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return safeParseMetadata(output) ?? emptyMetadata();
  } catch {
    return emptyMetadata();
  }
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
