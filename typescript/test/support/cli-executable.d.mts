export interface CliExecutable {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface CliExecutables {
  readonly cli: CliExecutable;
  readonly peer: CliExecutable;
}

export function resolveCliExecutables(env?: NodeJS.ProcessEnv): CliExecutables;
