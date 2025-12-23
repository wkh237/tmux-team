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

export interface ConfigDefaults {
  timeout: number; // seconds
  pollInterval: number; // seconds
  captureLines: number;
  preambleEvery: number; // inject preamble every N messages (default: 3)
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
}

export interface Flags {
  json: boolean;
  verbose: boolean;
  config?: string;
  force?: boolean;
  delay?: number; // seconds
  wait?: boolean;
  timeout?: number; // seconds
  noPreamble?: boolean;
}

export interface Paths {
  globalDir: string;
  globalConfig: string;
  localConfig: string;
  stateFile: string;
}

export interface UI {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  table: (headers: string[], rows: string[][]) => void;
  json: (data: unknown) => void;
}

export interface Tmux {
  send: (paneId: string, message: string) => void;
  capture: (paneId: string, lines: number) => string;
}

export interface WaitResult {
  requestId: string;
  nonce: string;
  startMarker: string;
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
  exit: (code: number) => never;
}
