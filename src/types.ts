import type { ActiveRegistration } from './domain/types.js';
import type { DurableIdentity, RoleProfile, TmuxBinding } from './domain/identity.js';

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
  globalIdentity?: {
    name: string;
    canonicalName: string;
    identityId?: string;
    bindingId?: string;
    serverId?: string;
    panePid?: number;
  };
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
}

export interface Paths {
  globalDir: string;
  globalConfig: string;
  localConfig: string;
  stateFile: string;
  /** User-scoped SQLite database used by durable v5 features. */
  databaseFile: string;
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
  panePid?: number;
  suggestedName: string | null; // e.g., "codex" if detected from command
  metadata?: PaneAgentMetadata;
}

export interface Tmux {
  send: (paneId: string, message: string, options?: { enterDelayMs?: number }) => void;
  capture: (paneId: string, lines: number) => string;
  listPanes: () => PaneInfo[];
  getCurrentPaneId: () => string | null;
  resolvePaneTarget: (target: string) => string | null;
  setPaneTitle: (paneId: string, title: string) => void;
  getAgentRegistry: (scope: RegistryScope) => TmuxRegistry;
  setAgentRegistration: (
    paneId: string,
    scope: RegistryScope,
    registration: AgentRegistration
  ) => void;
  clearAgentRegistration: (name: string, scope: RegistryScope) => boolean;
  listGlobalIdentities: () => ActiveRegistration[];
  setGlobalIdentity: (paneId: string, name: string) => void;
  clearGlobalIdentity: (paneId: string) => boolean;
  getEndpointSnapshot?: (options?: TmuxOperationOptions) => TmuxEndpointSnapshot;
  setDurableIdentity?: (
    paneId: string,
    identity: DurableIdentity,
    binding: TmuxBinding,
    options?: TmuxOperationOptions
  ) => void;
  clearDurableIdentity?: (
    paneId: string,
    bindingId?: string,
    options?: TmuxOperationOptions
  ) => boolean;
  /** Probe a previously recorded socket without changing its server state. */
  probeEndpoint?: (
    socketPath: string,
    serverPid: number,
    options?: TmuxOperationOptions
  ) => TmuxEndpointProbe;
}

export interface TmuxOperationOptions {
  /** Monotonic deadline shared by every subprocess in one operation. */
  readonly deadlineMs?: number;
}

export interface TmuxServerEvidence {
  readonly serverId: string;
  readonly socketPath: string;
  readonly serverPid: number;
  readonly serverStartTime: string;
}

export interface TmuxEndpointSnapshot {
  readonly server: TmuxServerEvidence;
  readonly panes: readonly PaneInfo[];
}

export type TmuxEndpointProbe =
  | { readonly status: 'live'; readonly snapshot: TmuxEndpointSnapshot }
  | { readonly status: 'dead' }
  | { readonly status: 'unknown' };

export interface IdentityService {
  bindCurrent(name: string): DurableIdentity;
  bindPane(pane: string, name: string): DurableIdentity;
  unbindCurrent(): DurableIdentity | undefined;
  currentIdentity(): { identity: DurableIdentity; binding: TmuxBinding } | undefined;
  activeIdentities(): Array<{ identity: DurableIdentity; binding: TmuxBinding; pane: PaneInfo }>;
  resolveActive(
    target: string
  ): { identity: DurableIdentity; binding: TmuxBinding; pane: PaneInfo } | undefined;
  reconcile(): void;
  close(): void;
}

export interface RoleService {
  show(selector?: import('./identity-context.js').IdentitySelector): RoleResult;
  set(
    selector: import('./identity-context.js').IdentitySelector | undefined,
    content: string
  ): RoleResult;
  clear(selector?: import('./identity-context.js').IdentitySelector): RoleResult;
}

export interface RoleResult {
  readonly identity: Pick<DurableIdentity, 'id' | 'name' | 'canonicalName'>;
  readonly role: RoleProfile | null;
}

export interface RegistryScope {
  type: 'workspace';
  workspaceRoot: string;
}

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
  identityService?: IdentityService;
  roleService?: RoleService;
  dispose?: () => void;
}
