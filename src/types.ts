// ─────────────────────────────────────────────────────────────
// Shared TypeScript interfaces for tmux-team
// ─────────────────────────────────────────────────────────────

export interface AgentConfig {
  preamble?: string;
  deny?: string[]; // Permission deny patterns, e.g., ["pm:task:update(status)"]
}

export interface PaneEntry {
  pane: string;
  remark?: string;
  preamble?: string; // Agent preamble (prepended to messages)
  deny?: string[]; // Permission deny patterns
}

export interface AgentRegistration {
  name: string;
  remark?: string;
  preamble?: string;
  deny?: string[];
}

export interface PaneAgentMetadata {
  version: 1;
  workspaces?: Record<string, AgentRegistration>;
  teams?: Record<string, AgentRegistration>;
}

export interface TmuxRegistry {
  paneRegistry: Record<string, PaneEntry>;
  agents: Record<string, AgentConfig>;
}

export interface ConfigDefaults {
  timeout: number; // seconds
  pollInterval: number; // seconds
  captureLines: number;
  maxCaptureLines: number; // max lines for final extraction (default: 2000)
  preambleEvery: number; // inject preamble every N messages (default: 3)
  pasteEnterDelayMs: number; // delay after paste before Enter (default: 500)
}

export interface GlobalConfig {
  mode: 'polling' | 'wait';
  preambleMode: 'always' | 'disabled';
  defaults: ConfigDefaults;
}

export interface LocalSettings {
  mode?: 'polling' | 'wait';
  preambleMode?: 'always' | 'disabled';
  preambleEvery?: number; // local override for preamble frequency
  pasteEnterDelayMs?: number; // local override for paste-enter delay
}

export interface LocalConfigFile {
  $config?: LocalSettings;
  [agentName: string]: PaneEntry | LocalSettings | undefined;
}

export interface LocalConfig {
  [agentName: string]: PaneEntry;
}

export interface ResolvedConfig {
  mode: 'polling' | 'wait';
  preambleMode: 'always' | 'disabled';
  defaults: ConfigDefaults;
  agents: Record<string, AgentConfig>;
  paneRegistry: Record<string, PaneEntry>;
  registrySource?: 'tmux' | 'legacy' | 'none';
}

export interface Flags {
  json: boolean;
  verbose: boolean;
  debug?: boolean;
  config?: string;
  force?: boolean;
  delay?: number; // seconds
  wait?: boolean;
  timeout?: number; // seconds
  lines?: number; // lines to capture before end marker
  noPreamble?: boolean;
  team?: string; // shared team name for cross-folder collaboration
}

export interface Paths {
  globalDir: string;
  globalConfig: string;
  localConfig: string;
  stateFile: string;
  workspaceRoot?: string;
}

export interface UI {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  table: (headers: string[], rows: string[][]) => void;
  json: (data: unknown) => void;
}

export interface PaneInfo {
  id: string; // e.g., "%1"
  target?: string; // e.g., "main:1.0"
  cwd?: string; // pane_current_path
  command: string; // e.g., "node", "python", "zsh"
  suggestedName: string | null; // e.g., "codex" if detected from command
  metadata?: PaneAgentMetadata;
}

export interface TeamPaneRegistration {
  scopeType: 'workspace' | 'team';
  scope: string;
  agent: string;
  remark?: string;
}

export interface TeamPaneInfo {
  pane: string;
  target?: string;
  cwd?: string;
  command: string;
  suggestedName: string | null;
  registrations: TeamPaneRegistration[];
}

export interface Tmux {
  send: (paneId: string, message: string, options?: { enterDelayMs?: number }) => void;
  capture: (paneId: string, lines: number) => string;
  listPanes: () => PaneInfo[];
  getCurrentPaneId: () => string | null;
  resolvePaneTarget: (target: string) => string | null;
  getAgentRegistry: (scope: RegistryScope) => TmuxRegistry;
  setAgentRegistration: (
    paneId: string,
    scope: RegistryScope,
    registration: AgentRegistration
  ) => void;
  clearAgentRegistration: (name: string, scope: RegistryScope) => boolean;
  listTeams: () => Record<string, string[]>;
  listTeamPanes: () => TeamPaneInfo[];
  removeTeam: (teamName: string) => { removed: number; agents: string[] };
}

export type RegistryScope =
  | { type: 'workspace'; workspaceRoot: string }
  | { type: 'team'; teamName: string };

export interface WaitResult {
  requestId: string;
  nonce: string;
  endMarker: string;
  response: string;
}

export interface Context {
  argv: string[];
  flags: Flags;
  ui: UI;
  config: ResolvedConfig;
  tmux: Tmux;
  paths: Paths;
  registryScope?: RegistryScope;
  exit: (code: number) => never;
}
