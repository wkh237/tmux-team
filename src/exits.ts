// ─────────────────────────────────────────────────────────────
// Exit code registry
// ─────────────────────────────────────────────────────────────

export const ExitCodes = {
  SUCCESS: 0,
  ERROR: 1,
  CONFIG_MISSING: 2,
  PANE_NOT_FOUND: 3,
  TIMEOUT: 4,
  CONFLICT: 5,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];
