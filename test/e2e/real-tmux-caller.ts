import fs from 'node:fs';
import path from 'node:path';
import type { E2EFixture } from './harness.js';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface RealTmuxCli {
  readonly pane: string;
  readonly panePid: number;
  readonly outputPath: string;
  readonly errorPath: string;
  readonly exitPath: string;
  readonly releasePath: string;
}

/**
 * Launch one real CLI process as a child of a tmux pane process. The command
 * deliberately removes the normal tmux environment so caller discovery must
 * use the process ancestry and the private server's real pane list.
 */
export async function spawnRealTmuxCli(
  fixture: E2EFixture,
  args: string[],
  options: {
    readonly name: string;
    readonly stripTmux?: boolean;
    readonly stripPane?: boolean;
    readonly json?: boolean;
  }
): Promise<RealTmuxCli> {
  const workspace = fixture.createWorkspace(`real-${options.name}`);
  const outputPath = path.join(workspace, 'stdout');
  const errorPath = path.join(workspace, 'stderr');
  const exitPath = path.join(workspace, 'exit');
  const releasePath = path.join(workspace, 'release');
  const holdPath = path.join(workspace, 'hold-until-server-cleanup');
  const cli = fixture.executables.cli;
  const invocation = [
    cli.executable,
    ...cli.args,
    ...(options.json === false ? [] : ['--json']),
    ...args,
  ];
  const command = [
    `while [ ! -f ${shellQuote(releasePath)} ]; do sleep 0.01; done`,
    `env${options.stripTmux ? ' -u TMUX' : ''}${options.stripPane ? ' -u TMUX_PANE' : ''} ${invocation.map(shellQuote).join(' ')} >${shellQuote(outputPath)} 2>${shellQuote(errorPath)}`,
    `printf '%s' "$?" >${shellQuote(exitPath)}`,
    `while [ ! -f ${shellQuote(holdPath)} ]; do sleep 0.05; done`,
  ].join('; ');
  const pane = fixture
    .tmux([
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      'e2e',
      '-n',
      options.name,
      '-c',
      workspace,
      `${shellQuote('/bin/sh')} -c ${shellQuote(command)}`,
    ])
    .trim();
  const panePid = Number(fixture.tmux(['display-message', '-p', '-t', pane, '#{pane_pid}']).trim());
  if (!pane || !Number.isInteger(panePid) || panePid <= 0) {
    throw new Error(`Could not create real CLI pane '${options.name}'.`);
  }
  await fixture.waitFor(() => fixture.mockProcessIsRunning(panePid), 2_000, 'real CLI pane');
  return { pane, panePid, outputPath, errorPath, exitPath, releasePath };
}

export async function releaseRealTmuxCli(fixture: E2EFixture, process: RealTmuxCli): Promise<void> {
  fs.writeFileSync(process.releasePath, 'run');
  await fixture.waitFor(
    () =>
      fs.existsSync(process.exitPath) && /^\d+$/.test(fs.readFileSync(process.exitPath, 'utf8')),
    5_000,
    'real CLI completion'
  );
}

export function readRealTmuxCli<T>(process: RealTmuxCli): {
  code: number;
  stdout: T;
  stderr: string;
} {
  const text = fs.readFileSync(process.outputPath, 'utf8');
  return {
    code: Number(fs.readFileSync(process.exitPath, 'utf8')),
    stdout: (text.trimStart().startsWith('{') ? JSON.parse(text) : text) as T,
    stderr: fs.readFileSync(process.errorPath, 'utf8'),
  };
}
