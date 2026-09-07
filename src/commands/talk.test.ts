import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context, Flags, Paths, ResolvedConfig, Tmux, UI } from '../types.js';
import type {
  RequestEndpoint,
  RequestService,
  RequestAttemptRecord,
  RequestSettlement,
} from '../request-service.js';
import { createRequestService } from '../request-service.js';
import { openIdentityRepository, type IdentityRepository } from '../storage/identity-repository.js';
import { ExitCodes } from '../exits.js';
import { TmuxDeliveryError } from '../message-delivery.js';
import { decodeReplyReceipt } from '../reply-receipt.js';
import { MAX_OBSERVER_TIMEOUT_SECONDS, MAX_TIMER_DELAY_MS } from '../domain/interaction-limits.js';
import { createDefaultConfig } from '../config-settings.js';
import { cmdTalk } from './talk.js';
import type { TalkRequest } from '../cli/requests.js';
import { isPaneTarget } from '../domain/names.js';
import { MAX_REQUEST_CONTENT_BYTES } from '../domain/request-content.js';
import { IdentityServiceError } from '../identity-service.js';

function talkRequest(target: string, message: string): TalkRequest {
  return {
    kind: 'talk',
    target: { value: target, kind: isPaneTarget(target) ? 'pane' : 'identity' },
    message,
  };
}

const ENDPOINT = {
  serverId: 'server-test',
  socketPath: '/tmp/tmt-test',
  serverPid: 123,
  serverStartTime: 'test-start',
  paneId: '%1',
  panePid: 456,
} as const;

type SentMessage = { pane: string; message: string };
interface MockTmux extends Tmux {
  readonly sends: SentMessage[];
  readonly captureCalls: number;
}
interface RequestFixture {
  readonly repository: IdentityRepository;
  readonly service: RequestService;
  readonly identityIds: ReadonlyMap<string, string>;
}
interface TestUI extends UI {
  readonly errors: string[];
  readonly warnings: string[];
  readonly jsonOutput: unknown[];
}

const fixtures = new Map<string, RequestFixture>();
const temporaryDirectories = new Set<string>();

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function closeFixtures(): void {
  for (const fixture of fixtures.values()) fixture.repository.close();
  fixtures.clear();
  for (const directory of temporaryDirectories)
    fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
}
afterEach(closeFixtures);

function requestFixture(databaseFile: string): RequestFixture {
  const existing = fixtures.get(databaseFile);
  if (existing) return existing;
  const repository = openIdentityRepository(databaseFile);
  try {
    const identityIds = new Map<string, string>();
    for (const name of ['claude', 'codex', 'gemini', 'all']) {
      const identity =
        repository.findByCanonicalName(name) ?? repository.createIdentity(name, name);
      identityIds.set(name, identity.id);
    }
    const fixture = {
      repository,
      service: createRequestService({ repository }),
      identityIds,
    };
    fixtures.set(databaseFile, fixture);
    return fixture;
  } catch (error) {
    repository.close();
    throw error;
  }
}

function createUI(): TestUI {
  const errors: string[] = [];
  const warnings: string[] = [];
  const jsonOutput: unknown[] = [];
  return {
    errors,
    warnings,
    jsonOutput,
    info: vi.fn(),
    success: vi.fn(),
    warn: (message: string) => warnings.push(message),
    error: (message: string) => errors.push(message),
    table: vi.fn(),
    json: (value: unknown) => jsonOutput.push(value),
  };
}

function activeIdentity(name: string, paneId: string) {
  const panePid = ENDPOINT.panePid + Number(paneId.slice(1)) - 1;
  return {
    identity: {
      id: `identity-${name}`,
      name,
      canonicalName: name,
      createdAt: 'now',
      updatedAt: 'now',
    },
    binding: {
      id: `binding-${name}`,
      identityId: `identity-${name}`,
      transport: 'tmux' as const,
      paneId,
      serverId: ENDPOINT.serverId,
      socketPath: ENDPOINT.socketPath,
      serverPid: ENDPOINT.serverPid,
      serverStartTime: ENDPOINT.serverStartTime,
      panePid,
      boundAt: 'now',
      lastVerifiedAt: 'now',
    },
    pane: {
      id: paneId,
      command: name,
      suggestedName: name,
      panePid,
      metadata: {
        version: 1 as const,
        globalIdentity: {
          name,
          canonicalName: name,
          identityId: `identity-${name}`,
          bindingId: `binding-${name}`,
          serverId: ENDPOINT.serverId,
          panePid,
        },
      },
    },
  };
}

function createMockTmux(options: { readonly onSend?: (message: string) => void } = {}): MockTmux {
  const sends: SentMessage[] = [];
  let captureCalls = 0;
  return {
    sends,
    get captureCalls() {
      return captureCalls;
    },
    send(pane, message) {
      sends.push({ pane, message });
      options.onSend?.(message);
    },
    capture() {
      captureCalls += 1;
      throw new Error('terminal capture is not a durable completion oracle');
    },
    listPanes: () => [],
    getCurrentPaneId: () => null,
    resolvePaneTarget: (target: string) => target,
    setPaneBadge: () => undefined,
    getEndpointSnapshot: () => ({
      server: {
        serverId: ENDPOINT.serverId,
        socketPath: ENDPOINT.socketPath,
        serverPid: ENDPOINT.serverPid,
        serverStartTime: ENDPOINT.serverStartTime,
      },
      panes: [
        activeIdentity('claude', '%1').pane,
        activeIdentity('codex', '%2').pane,
        activeIdentity('gemini', '%3').pane,
        { id: '%9', command: 'test-agent', panePid: 459, suggestedName: null },
      ],
    }),
  };
}

function createPaths(root: string): Paths {
  return {
    globalDir: root,
    globalConfig: path.join(root, 'config.json'),
    localConfig: path.join(root, 'tmux-team.json'),
    stateFile: path.join(root, 'state.json'),
    databaseFile: path.join(root, 'tmux-team.db'),
  };
}

function createConfig(overrides: Partial<ResolvedConfig['defaults']> = {}): ResolvedConfig {
  const config = createDefaultConfig();
  config.defaults = {
    ...config.defaults,
    pollInterval: 0.001,
    pasteEnterDelayMs: 0,
    ...overrides,
  };
  return config;
}

function createPreambleService(content = 'Be concise'): NonNullable<Context['preambleService']> {
  const identities = new Map(
    ['claude', 'codex', 'gemini', 'all'].map((name) => [
      name,
      {
        id: `identity-${name}`,
        name,
        canonicalName: name,
        createdAt: 'now',
        updatedAt: 'now',
      },
    ])
  );
  return {
    show: vi.fn((name: string) => {
      const identity = identities.get(name);
      if (!identity) throw new Error(`Unknown identity: ${name}`);
      return { identity, preamble: content ? { content, updatedAt: 'now' } : null };
    }),
    set: vi.fn(),
    clear: vi.fn(),
    list: vi.fn(() => []),
  };
}

function createContext(
  root: string,
  overrides: Partial<{
    tmux: Tmux;
    ui: TestUI;
    config: ResolvedConfig;
    flags: Partial<Flags>;
    preambleService: NonNullable<Context['preambleService']>;
    requestService: RequestService;
    identities: string[];
  }> = {}
): Context {
  const paths = createPaths(root);
  const fixture = requestFixture(paths.databaseFile);
  const sourcePreamble = overrides.preambleService ?? createPreambleService();
  const preambleService: NonNullable<Context['preambleService']> = {
    ...sourcePreamble,
    show(name: string) {
      const result = sourcePreamble.show(name);
      const identityId = fixture.identityIds.get(name);
      return identityId ? { ...result, identity: { ...result.identity, id: identityId } } : result;
    },
  };
  return {
    argv: [],
    flags: { json: true, verbose: false, ...overrides.flags } as Flags,
    ui: overrides.ui ?? createUI(),
    config: overrides.config ?? createConfig(),
    tmux: overrides.tmux ?? createMockTmux(),
    identityService: {
      createIdentity: vi.fn(() => {
        throw new Error('Unexpected durable identity creation.');
      }),
      showIdentity: vi.fn(() => {
        throw new Error('Unexpected durable identity lookup.');
      }),
      listIdentities: vi.fn(() => {
        throw new Error('Unexpected durable identity listing.');
      }),
      bindCurrent: vi.fn(),
      bindPane: vi.fn(),
      unbindCurrent: vi.fn(),
      currentIdentity: vi.fn(),
      resolveIdentity: vi.fn(() => ({ status: 'required' as const })),
      activeIdentities: vi.fn(() =>
        (overrides.identities ?? ['claude', 'codex', 'gemini']).map((name, index) =>
          activeIdentity(name, `%${index + 1}`)
        )
      ),
      resolveActive: vi.fn((target: string) =>
        (overrides.identities ?? ['claude', 'codex', 'gemini'])
          .map((name, index) => activeIdentity(name, `%${index + 1}`))
          .find(
            (entry) => entry.binding.paneId === target || entry.identity.canonicalName === target
          )
      ),
      reconcile: vi.fn(),
    },
    preambleService,
    requestService: overrides.requestService ?? fixture.service,
    paths,
    exit: ((code: number): never => {
      throw Object.assign(new Error(`exit(${code})`), { exitCode: code });
    }) as Context['exit'],
  };
}

function onlyAttempt(service: RequestService): RequestAttemptRecord {
  const records = service.listAttempts();
  if (records.length !== 1) throw new Error(`Expected one attempt, found ${records.length}.`);
  return records[0]!;
}

function attemptFromInstruction(service: RequestService, message: string): RequestAttemptRecord {
  const match = message.match(/^tmt reply (\S+) --receipt (\S+) --message <text>$/m);
  const requestId = match?.[1];
  const encodedReceipt = match?.[2];
  if (!requestId || !encodedReceipt) throw new Error('Durable receipt instruction is incomplete.');
  const receipt = decodeReplyReceipt(encodedReceipt, requestId);
  const attempt = service.getAttempt(receipt.attemptId);
  if (!attempt) throw new Error(`Attempt '${receipt.attemptId}' was not persisted.`);
  return attempt;
}

function endpointOf(attempt: RequestAttemptRecord): RequestEndpoint {
  return {
    serverId: attempt.serverId,
    socketPath: attempt.socketPath,
    serverPid: attempt.serverPid,
    serverStartTime: attempt.serverStartTime,
    paneId: attempt.paneId,
    panePid: attempt.panePid,
  };
}

function submitFor(service: RequestService, attempt: RequestAttemptRecord, body: string): void {
  service.submitResponse({
    requestId: attempt.requestId,
    attemptId: attempt.attemptId,
    endpoint: endpointOf(attempt),
    body,
  });
}

function stateSnapshot(root: string): {
  attempts: unknown[];
  responses: unknown[];
  cadence: unknown[];
} {
  const database = new Database(createPaths(root).databaseFile, { readonly: true });
  try {
    return {
      attempts: database.prepare('SELECT * FROM request_attempts ORDER BY attempt_id').all(),
      responses: database.prepare('SELECT * FROM request_responses ORDER BY request_id').all(),
      cadence: database.prepare('SELECT * FROM preamble_counters ORDER BY identity_id').all(),
    };
  } finally {
    database.close();
  }
}

describe('cmdTalk durable completion', () => {
  it.each(['unknown', 'verified', 'explicit'] as const)(
    'persists %s originator separately from recipient and exact original text',
    async (kind) => {
      const root = temporaryDirectory('tmt-talk-context-');
      const fixture = requestFixture(createPaths(root).databaseFile);
      const tmux = createMockTmux();
      const ctx = createContext(root, { tmux, flags: { detach: true } });
      const originator = fixture.repository.findByCanonicalName('codex')!;
      ctx.identityService.resolveIdentity = vi.fn(() =>
        kind === 'unknown' ? { status: 'required' } : { status: 'bound', identity: originator }
      );
      // Unicode and control characters are exact payload fixtures, not prose conventions.
      const message = '\ufeffif (!ready)\r\n\u0000日本語 😀\n  ';
      const request: TalkRequest = {
        ...talkRequest('%1', message),
        ...(kind === 'explicit' && {
          originator: { value: 'codex', kind: 'identity', explicit: true } as const,
        }),
      };
      await cmdTalk(ctx, request);
      const attempt = onlyAttempt(fixture.service);
      expect(attempt.originator).toEqual(
        kind === 'unknown' ? { kind } : { kind, identityId: originator.id }
      );
      expect(attempt.recipientIdentityId).toBe('identity-claude');
      const context = fixture.service.getRequestContext(attempt.requestId);
      expect(context?.prompt).toEqual({
        status: 'retained',
        message,
        messageBytes: Buffer.byteLength(message),
        expiresAtMs: attempt.preparedAtMs + attempt.retentionDays * 86_400_000,
      });
      expect(tmux.sends[0]?.message).toContain('[SYSTEM: Be concise]');
      expect(tmux.sends[0]?.message).toContain('<tmt-reply>');
      expect(attempt).not.toHaveProperty('message');
      expect(attempt).not.toHaveProperty('messageBytes');
      expect(ctx.identityService.resolveIdentity).toHaveBeenCalledOnce();
      expect(ctx.identityService.resolveIdentity).toHaveBeenCalledWith(request.originator);
      expect((ctx.ui as TestUI).jsonOutput).toEqual([
        {
          status: 'sent',
          requestId: attempt.requestId,
          target: '%1',
          pane: '%1',
          identity: { name: 'claude', canonicalName: 'claude' },
        },
      ]);
    }
  );

  it.each([
    { label: 'lone surrogate', message: '\ud800', code: 'REQUEST_INPUT_INVALID' },
    {
      label: 'over byte cap',
      message: 'x'.repeat(MAX_REQUEST_CONTENT_BYTES + 1),
      code: 'REQUEST_INPUT_TOO_LARGE',
    },
  ])(
    'rejects $label before any target, originator, delay or storage effect',
    async ({ message, code }) => {
      const root = temporaryDirectory('tmt-talk-invalid-original-');
      const ctx = createContext(root, { flags: { detach: true, delay: 1 } });
      const before = stateSnapshot(root);
      const target = vi.spyOn(ctx.tmux, 'resolvePaneTarget');
      const sleep = vi.fn(async () => undefined);
      await expect(cmdTalk(ctx, talkRequest('%1', message), { sleep })).rejects.toMatchObject({
        exitCode: 1,
      });
      expect((ctx.ui as TestUI).jsonOutput).toEqual([
        { error: { code, message: expect.any(String) } },
      ]);
      expect(target).not.toHaveBeenCalled();
      expect(ctx.identityService.activeIdentities).not.toHaveBeenCalled();
      expect(ctx.identityService.resolveIdentity).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      expect(stateSnapshot(root)).toEqual(before);
    }
  );

  it.each([
    { status: 'not-found' as const, code: 'NAME_NOT_FOUND', exitCode: 3 },
    { status: 'ambiguous' as const, code: 'IDENTITY_AMBIGUOUS', exitCode: 1 },
  ])(
    'rejects $status originator without falling back or preparing',
    async ({ status, code, exitCode }) => {
      const root = temporaryDirectory('tmt-talk-originator-error-');
      const tmux = createMockTmux();
      const ctx = createContext(root, { tmux, flags: { detach: true } });
      ctx.identityService.resolveIdentity = vi.fn(() => ({ status }));
      const before = stateSnapshot(root);
      const request = {
        ...talkRequest('claude', 'must not send'),
        originator: { value: 'missing', kind: 'identity' as const, explicit: true },
      };
      await expect(cmdTalk(ctx, request)).rejects.toMatchObject({ exitCode });
      expect((ctx.ui as TestUI).jsonOutput).toEqual([
        { error: { code, message: expect.any(String) } },
      ]);
      expect(tmux.sends).toEqual([]);
      expect(stateSnapshot(root)).toEqual(before);
    }
  );

  it('reports recipient errors before looking up an invalid originator', async () => {
    const root = temporaryDirectory('tmt-talk-selection-order-');
    const ctx = createContext(root, { flags: { detach: true } });
    const before = stateSnapshot(root);
    await expect(
      cmdTalk(ctx, {
        ...talkRequest('missing-recipient', 'must not send'),
        originator: { value: 'missing-originator', kind: 'identity', explicit: true },
      })
    ).rejects.toMatchObject({ exitCode: 3 });
    expect((ctx.ui as TestUI).jsonOutput).toEqual([
      { error: { code: 'NAME_NOT_FOUND', message: "Identity 'missing-recipient' is not active." } },
    ]);
    expect(ctx.identityService.resolveIdentity).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
  });

  it('does not silently anonymize an originator reconciliation failure', async () => {
    const root = temporaryDirectory('tmt-talk-originator-reconcile-');
    const tmux = createMockTmux();
    const ctx = createContext(root, { tmux, flags: { detach: true } });
    ctx.identityService.resolveIdentity = vi.fn(() => {
      throw new IdentityServiceError('RECONCILIATION_FAILED', 'Could not inspect caller.');
    });
    const before = stateSnapshot(root);
    await expect(cmdTalk(ctx, talkRequest('claude', 'must not send'))).rejects.toMatchObject({
      exitCode: 1,
    });
    expect((ctx.ui as TestUI).jsonOutput).toEqual([
      { error: { code: 'RECONCILIATION_FAILED', message: 'Could not inspect caller.' } },
    ]);
    expect(tmux.sends).toEqual([]);
    expect(stateSnapshot(root)).toEqual(before);
  });

  it.each([
    'serverId',
    'socketPath',
    'serverPid',
    'serverStartTime',
    'panePid',
    'identityId',
    'bindingId',
  ] as const)(
    'rejects changed recipient %s evidence before attempt/cadence/send',
    async (field) => {
      const root = temporaryDirectory('tmt-talk-recipient-race-');
      const tmux = createMockTmux();
      const original = tmux.getEndpointSnapshot!();
      const snapshot = { ...original, server: { ...original.server } };
      if (field === 'panePid') snapshot.panes[0]!.panePid! += 1;
      else if (field === 'identityId' || field === 'bindingId')
        snapshot.panes[0]!.metadata!.globalIdentity![field] = 'replacement';
      else if (field === 'serverPid') snapshot.server.serverPid += 1;
      else snapshot.server[field] = 'replacement';
      tmux.getEndpointSnapshot = () => snapshot;
      const ctx = createContext(root, { tmux, flags: { detach: true } });
      const before = stateSnapshot(root);
      await expect(cmdTalk(ctx, talkRequest('claude', 'must not send'))).rejects.toMatchObject({
        exitCode: 1,
      });
      expect((ctx.ui as TestUI).jsonOutput).toEqual([
        { error: { code: 'RECONCILIATION_FAILED', message: expect.any(String) } },
      ]);
      expect(tmux.sends).toEqual([]);
      expect(stateSnapshot(root)).toEqual(before);
    }
  );

  it('sends an exact receipt instruction and returns the durable body without capture', async () => {
    const root = temporaryDirectory('tmt-talk-success-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const body = '\ufefffirst\r\n\u0000日本語 😀\r\nRESPONSE-END-fake\n  ';
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), body),
    });
    const ctx = createContext(root, { tmux });
    await cmdTalk(ctx, talkRequest('claude', 'Hello!'));
    const attempt = onlyAttempt(fixture.service);
    expect((ctx.ui as TestUI).jsonOutput).toEqual([
      expect.objectContaining({
        status: 'completed',
        requestId: attempt.requestId,
        response: body,
        bodyBytes: Buffer.byteLength(body),
        submittedAtMs: expect.any(Number),
      }),
    ]);
    expect(tmux.captureCalls).toBe(0);
    expect(tmux.sends[0]?.message).toContain(attempt.requestId);
    expect(tmux.sends[0]?.message).toContain('<tmt-reply>');
    expect(tmux.sends[0]?.message).toContain('--receipt');
    expect(tmux.sends[0]?.message).toContain('--message <text>');
    expect(tmux.sends[0]?.message).not.toContain('--file');
    expect(tmux.sends[0]?.message).not.toContain('--stdin');
    const receipt = tmux.sends[0]?.message.match(
      /^tmt reply \S+ --receipt (\S+) --message <text>$/m
    )?.[1];
    expect(receipt).toBeTruthy();
    expect(decodeReplyReceipt(receipt!, attempt.requestId)).toMatchObject({
      version: 1,
      requestId: attempt.requestId,
      attemptId: attempt.attemptId,
      endpoint: ENDPOINT,
    });
    expect(stateSnapshot(root).responses).toHaveLength(1);
  });

  it('supports detach by recording sent state without polling or result output', async () => {
    const root = temporaryDirectory('tmt-talk-detach-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const tmux = createMockTmux();
    const ctx = createContext(root, { tmux, flags: { detach: true } });
    await cmdTalk(ctx, talkRequest('claude', 'Hello'));
    const attempt = onlyAttempt(fixture.service);
    expect((ctx.ui as TestUI).jsonOutput).toEqual([
      expect.objectContaining({
        status: 'sent',
        requestId: attempt.requestId,
        target: 'claude',
        pane: '%1',
      }),
    ]);
    expect(tmux.captureCalls).toBe(0);
    expect(stateSnapshot(root).responses).toEqual([]);
    expect(attempt.status).toBe('sent');
    expect(attempt.waitActive).toBe(false);
  });

  it('does not poll request results in detach mode', async () => {
    const root = temporaryDirectory('tmt-talk-detach-no-poll-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const getResponse = vi.fn(() => undefined);
    const service = { ...fixture.service, getResponse } as RequestService;
    const ctx = createContext(root, {
      requestService: service,
      tmux: createMockTmux(),
      flags: { detach: true },
    });
    await cmdTalk(ctx, talkRequest('claude', 'Hello'));
    expect(getResponse).not.toHaveBeenCalled();
  });

  it('warns about an overlapping waiter only for human output and suppresses it with force', async () => {
    const root = temporaryDirectory('tmt-talk-overlap-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const existing = fixture.service.prepare({
      message: 'Existing request',
      requestId: 'existing-request',
      endpoint: ENDPOINT,
      wait: true,
      expiresAtMs: Date.now() + 60 * 60 * 1000,
    });
    fixture.service.beginSend(existing.attemptId);

    const warningUI = createUI();
    const warningTmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'ok'),
    });
    const warningCtx = createContext(root, {
      tmux: warningTmux,
      ui: warningUI,
      flags: { json: false },
    });
    await cmdTalk(warningCtx, talkRequest('claude', 'Hello'));
    expect(warningUI.warnings.join('\n')).toContain('existing-request');

    const forceUI = createUI();
    const forceTmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'ok'),
    });
    const forceCtx = createContext(root, {
      tmux: forceTmux,
      ui: forceUI,
      flags: { json: false, force: true },
    });
    await cmdTalk(forceCtx, talkRequest('claude', 'Hello'));
    expect(forceUI.warnings).toEqual([]);
  });

  it('does not emit overlap warnings in JSON mode', async () => {
    const root = temporaryDirectory('tmt-talk-overlap-json-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const existing = fixture.service.prepare({
      message: 'Existing request',
      requestId: 'existing-json-request',
      endpoint: ENDPOINT,
      wait: true,
      expiresAtMs: Date.now() + 60 * 60 * 1000,
    });
    fixture.service.beginSend(existing.attemptId);
    const ui = createUI();
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'ok'),
    });
    const ctx = createContext(root, { tmux, ui, flags: { json: true } });
    await cmdTalk(ctx, talkRequest('claude', 'Hello'));
    expect(ui.warnings).toEqual([]);
    expect(ui.jsonOutput).toHaveLength(1);
  });

  it('reports human detach and completion summaries through UI with request inspection guidance', async () => {
    for (const detach of [true, false]) {
      const root = temporaryDirectory(`tmt-talk-human-${detach ? 'detach' : 'completed'}-`);
      const fixture = requestFixture(createPaths(root).databaseFile);
      const ui = createUI();
      const tmux = createMockTmux({
        onSend: (message) => {
          if (!detach)
            submitFor(
              fixture.service,
              attemptFromInstruction(fixture.service, message),
              'human result'
            );
        },
      });
      const ctx = createContext(root, {
        tmux,
        ui,
        flags: { json: false, ...(detach ? { detach: true } : {}) },
      });
      await cmdTalk(ctx, talkRequest('claude', 'Hello'));
      const requestId = onlyAttempt(fixture.service).requestId;
      expect(ui.info).toHaveBeenCalledWith(expect.stringContaining(requestId));
      expect(ui.info).toHaveBeenCalledWith(expect.stringContaining('result'));
    }
  });

  it('reports a human timeout with request correlation and result inspection guidance', async () => {
    const root = temporaryDirectory('tmt-talk-human-timeout-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const ui = createUI();
    const ctx = createContext(root, {
      tmux: createMockTmux(),
      ui,
      flags: { json: false, timeout: 0.01 },
      config: createConfig({ pollInterval: 0.001 }),
    });
    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.TIMEOUT,
    });
    const requestId = onlyAttempt(fixture.service).requestId;
    expect(ui.errors.join('\n')).toContain(requestId);
    expect(ui.errors.join('\n')).toContain('result');
  });

  it('preserves preamble injection, cadence reservation, and target identity', async () => {
    const root = temporaryDirectory('tmt-talk-preamble-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'ok'),
    });
    const ctx = createContext(root, { tmux });
    await cmdTalk(ctx, talkRequest('claude', 'Hello'));
    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0]?.pane).toBe('%1');
    expect(tmux.sends[0]?.message).toContain('[SYSTEM: Be concise]');
    const snapshot = stateSnapshot(root);
    expect(snapshot.cadence).toHaveLength(1);
    expect(snapshot.attempts[0]).toMatchObject({
      pane_id: '%1',
      cadence_reserved: 1,
      wait_active: 0,
    });
  });

  it.each([
    { every: 1, expected: [true, true, true, true] },
    { every: 3, expected: [true, false, false, true] },
  ])('reserves repeated preambles at cadence N=$every', async ({ every, expected }) => {
    const root = temporaryDirectory(`tmt-talk-cadence-${every}-`);
    const fixture = requestFixture(createPaths(root).databaseFile);
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'ok'),
    });
    for (let index = 0; index < expected.length; index += 1) {
      const ctx = createContext(root, {
        tmux,
        config: createConfig({ preambleEvery: every }),
      });
      await cmdTalk(ctx, talkRequest('claude', `message-${index}`));
      expect(tmux.sends[index]?.message.includes('[SYSTEM: Be concise]')).toBe(expected[index]);
    }
    const snapshot = stateSnapshot(root);
    expect(snapshot.cadence).toHaveLength(1);
    expect(snapshot.cadence[0]).toMatchObject({ reserved_count: expected.length });
  });

  it('normalizes identity names, injects for a bound direct pane, and skips unbound panes', async () => {
    const namedRoot = temporaryDirectory('tmt-talk-case-name-');
    const namedFixture = requestFixture(createPaths(namedRoot).databaseFile);
    const namedPreamble = createPreambleService();
    const namedTmux = createMockTmux({
      onSend: (message) =>
        submitFor(
          namedFixture.service,
          attemptFromInstruction(namedFixture.service, message),
          'ok'
        ),
    });
    const namedCtx = createContext(namedRoot, {
      tmux: namedTmux,
      preambleService: namedPreamble,
    });
    await cmdTalk(namedCtx, talkRequest('Claude', 'Hello'));
    expect(namedPreamble.show).toHaveBeenCalledWith('claude');
    expect(namedTmux.sends[0]?.message).toContain('[SYSTEM: Be concise]');

    const boundRoot = temporaryDirectory('tmt-talk-bound-pane-');
    const boundFixture = requestFixture(createPaths(boundRoot).databaseFile);
    const boundPreamble = createPreambleService();
    const boundTmux = createMockTmux({
      onSend: (message) =>
        submitFor(
          boundFixture.service,
          attemptFromInstruction(boundFixture.service, message),
          'ok'
        ),
    });
    const boundCtx = createContext(boundRoot, {
      tmux: boundTmux,
      preambleService: boundPreamble,
    });
    await cmdTalk(boundCtx, talkRequest('%1', 'Hello'));
    expect(boundPreamble.show).toHaveBeenCalledWith('claude');
    expect(boundTmux.sends[0]?.message).toContain('[SYSTEM: Be concise]');

    const unboundRoot = temporaryDirectory('tmt-talk-unbound-pane-');
    const unboundFixture = requestFixture(createPaths(unboundRoot).databaseFile);
    const unboundPreamble = createPreambleService();
    const unboundTmux = createMockTmux({
      onSend: (message) =>
        submitFor(
          unboundFixture.service,
          attemptFromInstruction(unboundFixture.service, message),
          'ok'
        ),
    });
    const unboundCtx = createContext(unboundRoot, {
      tmux: unboundTmux,
      preambleService: unboundPreamble,
    });
    await cmdTalk(unboundCtx, talkRequest('%9', 'Hello'));
    expect(unboundPreamble.show).not.toHaveBeenCalled();
    expect(unboundTmux.sends[0]?.message).not.toContain('[SYSTEM:');
  });

  it('does not look up or reserve a preamble when disabled, no-preamble is set, or cadence is zero', async () => {
    for (const variant of [
      { preambleMode: 'disabled' as const },
      { flags: { noPreamble: true } },
      { config: { preambleEvery: 0 } },
    ]) {
      const root = temporaryDirectory('tmt-talk-no-preamble-');
      const fixture = requestFixture(createPaths(root).databaseFile);
      const preambleService = createPreambleService();
      const tmux = createMockTmux({
        onSend: (message) =>
          submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'ok'),
      });
      const ctx = createContext(root, {
        tmux,
        preambleService,
        flags: variant.flags,
        config: {
          ...createConfig(variant.config),
          ...(variant.preambleMode ? { preambleMode: variant.preambleMode } : {}),
        },
      });
      await cmdTalk(ctx, talkRequest('claude', 'Hello'));
      expect(preambleService.show).not.toHaveBeenCalled();
      expect(stateSnapshot(root).cadence).toEqual([]);
      expect(tmux.sends[0]?.message).toMatch(/^Hello\n\n<tmt-reply>/);
      const attempt = onlyAttempt(fixture.service);
      expect(attempt.recipientIdentityId).toBe('identity-claude');
      expect(attempt.identityId).toBeUndefined();
    }
  });

  it('does not create cadence state when no-preamble delivery fails before transport', async () => {
    const root = temporaryDirectory('tmt-talk-no-preamble-refund-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const service = {
      ...fixture.service,
      beginSend: vi.fn(() => {
        throw new Error('begin send failed');
      }),
    } as RequestService;
    const ctx = createContext(root, {
      requestService: service,
      flags: { noPreamble: true },
      tmux: createMockTmux(),
    });
    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.ERROR,
    });
    expect(stateSnapshot(root).cadence).toEqual([]);
    expect(stateSnapshot(root).responses).toEqual([]);
  });

  it('keeps literal exclamation source text at the command boundary', async () => {
    const root = temporaryDirectory('tmt-talk-bang-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'ok'),
    });
    const ctx = createContext(root, { tmux, flags: { noPreamble: true } });
    await cmdTalk(ctx, talkRequest('%9', 'if (!ready) Hello!'));
    expect(tmux.sends[0]?.message).toContain('if (!ready) Hello!');
  });

  it('applies delay before transport and starts the observer deadline afterwards', async () => {
    const root = temporaryDirectory('tmt-talk-delay-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const sleeps: number[] = [];
    let clock = 1_000;
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(
          fixture.service,
          attemptFromInstruction(fixture.service, message),
          'delayed result'
        ),
    });
    const ctx = createContext(root, { tmux, flags: { delay: 2, timeout: 1 } });
    await cmdTalk(ctx, talkRequest('claude', 'Hello'), {
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });
    expect(sleeps).toEqual([2_000]);
    expect(tmux.sends).toHaveLength(1);
    expect(onlyAttempt(fixture.service).status).toBe('sent');
  });

  it('accepts the maximum observer timeout and timer delay', async () => {
    const root = temporaryDirectory('tmt-talk-timing-boundary-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const sleeps: number[] = [];
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'boundary'),
    });
    const ctx = createContext(root, {
      tmux,
      flags: {
        delay: MAX_TIMER_DELAY_MS / 1000,
        timeout: MAX_OBSERVER_TIMEOUT_SECONDS,
      },
    });

    await cmdTalk(ctx, talkRequest('claude', 'Hello'), {
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    expect(sleeps).toEqual([MAX_TIMER_DELAY_MS]);
    expect(tmux.sends).toHaveLength(1);
    expect(onlyAttempt(fixture.service).status).toBe('sent');
  });

  it('does not validate wait-only timing when detached', async () => {
    const root = temporaryDirectory('tmt-talk-detached-timing-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const tmux = createMockTmux();
    const ctx = createContext(root, {
      tmux,
      flags: { detach: true, timeout: 0 },
      config: createConfig({ pollInterval: 0 }),
    });

    await cmdTalk(ctx, talkRequest('claude', 'Detached'));

    expect(tmux.sends).toHaveLength(1);
    expect(onlyAttempt(fixture.service).status).toBe('sent');
  });

  it.each([
    { name: 'zero timeout', flags: { timeout: 0 } },
    {
      name: 'over-limit timeout',
      flags: { timeout: MAX_OBSERVER_TIMEOUT_SECONDS + 0.001 },
    },
    { name: 'infinite timeout', flags: { timeout: Infinity } },
    { name: 'negative delay', flags: { delay: -1 } },
    { name: 'non-finite delay', flags: { delay: Number.NaN } },
    { name: 'infinite delay', flags: { delay: Infinity } },
    {
      name: 'over-limit delay',
      flags: { delay: (MAX_TIMER_DELAY_MS + 1) / 1000 },
    },
    { name: 'zero poll interval', config: { pollInterval: 0 } },
    { name: 'non-finite poll interval', config: { pollInterval: Number.NaN } },
    { name: 'non-finite enter delay', config: { pasteEnterDelayMs: Number.NaN } },
    {
      name: 'over-limit enter delay',
      config: { pasteEnterDelayMs: MAX_TIMER_DELAY_MS + 1 },
    },
    {
      name: 'over-limit enter delay while detached',
      flags: { detach: true },
      config: { pasteEnterDelayMs: MAX_TIMER_DELAY_MS + 1 },
    },
  ])('rejects invalid $name before send or request preparation', async ({ flags, config }) => {
    const root = temporaryDirectory('tmt-talk-invalid-timing-');
    requestFixture(createPaths(root).databaseFile);
    const tmux = createMockTmux();
    const ctx = createContext(root, {
      tmux,
      flags,
      config: createConfig(config),
    });
    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.ERROR,
    });
    expect(tmux.sends).toEqual([]);
    expect(stateSnapshot(root).attempts).toEqual([]);
    expect(stateSnapshot(root).responses).toEqual([]);
  });

  it('refunds a definitely-unsent begin failure without sending or mutating state', async () => {
    const root = temporaryDirectory('tmt-talk-refund-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const service = {
      ...fixture.service,
      beginSend: vi.fn(() => {
        throw new Error('state write failed');
      }),
    } as RequestService;
    const tmux = createMockTmux();
    const ctx = createContext(root, { tmux, requestService: service });
    const before = stateSnapshot(root);
    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.ERROR,
    });
    expect(tmux.sends).toHaveLength(0);
    expect(stateSnapshot(root).responses).toEqual(before.responses);
    expect(stateSnapshot(root).cadence).toEqual([expect.objectContaining({ reserved_count: 0 })]);
    expect((ctx.ui as TestUI).jsonOutput).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: 'REQUEST_STATE_ERROR' }),
      }),
    ]);
  });

  it('records typed transport uncertainty, releases the waiter, and never replays', async () => {
    const root = temporaryDirectory('tmt-talk-uncertain-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const tmux = createMockTmux();
    tmux.send = vi.fn(() => {
      throw new TmuxDeliveryError('paste');
    });
    const ctx = createContext(root, { tmux });
    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.ERROR,
    });
    expect(tmux.send).toHaveBeenCalledTimes(1);
    const attempt = onlyAttempt(fixture.service);
    expect(attempt.status).toBe('uncertain');
    expect(attempt.waitActive).toBe(false);
    expect((ctx.ui as TestUI).jsonOutput).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: 'DELIVERY_UNCERTAIN', stage: 'paste' }),
      }),
    ]);
  });

  it('returns a correlated timeout without capture fields and leaves the late result available', async () => {
    const root = temporaryDirectory('tmt-talk-timeout-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const tmux = createMockTmux();
    const ctx = createContext(root, {
      tmux,
      flags: { timeout: 0.01 },
      config: createConfig({ pollInterval: 0.001 }),
    });
    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.TIMEOUT,
    });
    const timeout = (ctx.ui as TestUI).jsonOutput[0] as Record<string, unknown>;
    expect(timeout).toMatchObject({
      status: 'timeout',
      requestId: expect.any(String),
      error: { code: 'TIMEOUT' },
    });
    for (const forbidden of ['partialResponse', 'nonce', 'endMarker', 'truncated'])
      expect(timeout).not.toHaveProperty(forbidden);
    const attempt = onlyAttempt(fixture.service);
    expect(attempt.waitActive).toBe(false);
    expect(attempt.status).toBe('sent');
    submitFor(fixture.service, attempt, 'late durable response');
    expect(fixture.service.getResponse(attempt.requestId)?.body).toBe('late durable response');
  });

  it('interrupts only its waiter, emits a correlated error, and leaves no response', async () => {
    vi.useFakeTimers();
    const root = temporaryDirectory('tmt-talk-interrupt-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    let interrupted = false;
    const ctx = createContext(root, {
      tmux: createMockTmux(),
      flags: { timeout: 1 },
      config: createConfig({ pollInterval: 0.1 }),
    });
    const listenersBefore = process.listenerCount('SIGINT');
    try {
      await expect(
        cmdTalk(ctx, talkRequest('claude', 'Hello'), {
          now: () => 50_000,
          sleep: async () => {
            if (!interrupted) {
              interrupted = true;
              process.emit('SIGINT');
            }
          },
        })
      ).rejects.toMatchObject({ exitCode: ExitCodes.ERROR });
      const output = (ctx.ui as TestUI).jsonOutput[0] as Record<string, unknown>;
      const attempt = onlyAttempt(fixture.service);
      expect(output).toMatchObject({
        requestId: attempt.requestId,
        error: { code: 'INTERRUPTED' },
      });
      expect(attempt.waitActive).toBe(false);
      expect(fixture.service.getResponse(attempt.requestId)).toBeUndefined();
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses monotonic equality as a timeout boundary and never reads after the deadline', async () => {
    const root = temporaryDirectory('tmt-talk-clock-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const tmux = createMockTmux();
    const getResponse = vi.fn(() => undefined);
    const service = { ...fixture.service, getResponse } as RequestService;
    let clock = 1_000;
    const ctx = createContext(root, {
      tmux,
      requestService: service,
      flags: { timeout: 0.01 },
      config: createConfig({ pollInterval: 0.001 }),
    });
    const promise = cmdTalk(ctx, talkRequest('claude', 'Hello'), {
      now: () => clock,
      sleep: async () => {
        clock = 1_010;
      },
    });
    await expect(promise).rejects.toMatchObject({ exitCode: ExitCodes.TIMEOUT });
    expect(getResponse).toHaveBeenCalledTimes(1);
    expect(tmux.captureCalls).toBe(0);
    expect(onlyAttempt(fixture.service).waitActive).toBe(false);
  });

  it('cleans the real pending poll timer and SIGINT listener, while retaining late replies', async () => {
    vi.useFakeTimers();
    const root = temporaryDirectory('tmt-talk-real-interrupt-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const ui = createUI();
    const listenersBefore = process.listenerCount('SIGINT');
    const ctx = createContext(root, {
      tmux: createMockTmux(),
      ui,
      flags: { timeout: 60 },
      config: createConfig({ pollInterval: 10 }),
    });
    try {
      const pending = cmdTalk(ctx, talkRequest('claude', 'Hello'));
      await Promise.resolve();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      process.emit('SIGINT');
      await expect(pending).rejects.toMatchObject({ exitCode: ExitCodes.ERROR });
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
      expect(vi.getTimerCount()).toBe(0);
      const attempt = onlyAttempt(fixture.service);
      expect(attempt.waitActive).toBe(false);
      submitFor(fixture.service, attempt, 'late after interrupt');
      expect(fixture.service.getResponse(attempt.requestId)?.body).toBe('late after interrupt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes synchronous send time in the observer timeout budget', async () => {
    const root = temporaryDirectory('tmt-talk-transport-overrun-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    let clock = 10_000;
    const tmux = createMockTmux({ onSend: () => (clock += 20) });
    const ctx = createContext(root, {
      tmux,
      flags: { timeout: 0.01 },
      config: createConfig({ pollInterval: 0.001 }),
    });
    await expect(
      cmdTalk(ctx, talkRequest('claude', 'Hello'), {
        now: () => clock,
        sleep: async () => undefined,
      })
    ).rejects.toMatchObject({ exitCode: ExitCodes.TIMEOUT });
    expect(tmux.captureCalls).toBe(0);
    expect(onlyAttempt(fixture.service).waitActive).toBe(false);
  });

  it('correlates a settle failure after delivery without replaying the request', async () => {
    const root = temporaryDirectory('tmt-talk-settle-failure-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const settle = vi.fn((attemptId: string, outcome: RequestSettlement) => {
      if (outcome === 'sent') throw new Error('settle persistence failed after delivery');
      return fixture.service.settle(attemptId, outcome);
    });
    const service = { ...fixture.service, settle } as RequestService;
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'delivered'),
    });
    const ctx = createContext(root, { tmux, requestService: service });

    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.ERROR,
    });
    const attempt = onlyAttempt(fixture.service);
    const output = (ctx.ui as TestUI).jsonOutput[0] as {
      requestId: string;
      error: { code: string; suggestion: string };
    };
    expect(output).toMatchObject({
      requestId: attempt.requestId,
      error: {
        code: 'REQUEST_STATE_ERROR',
        suggestion: expect.stringContaining(attempt.requestId),
      },
    });
    expect(tmux.sends).toHaveLength(1);
    expect(fixture.service.getResponse(attempt.requestId)?.body).toBe('delivered');
    expect(settle).toHaveBeenCalledWith(attempt.attemptId, 'sent');
  });

  it('correlates a response-read failure after delivery without replaying the request', async () => {
    const root = temporaryDirectory('tmt-talk-read-failure-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const getResponse = vi.fn(() => {
      throw new Error('response read failed after delivery');
    });
    const service = { ...fixture.service, getResponse } as RequestService;
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'delivered'),
    });
    const ctx = createContext(root, {
      tmux,
      requestService: service,
      config: createConfig({ pollInterval: 0.001 }),
    });

    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.ERROR,
    });
    const attempt = onlyAttempt(fixture.service);
    expect((ctx.ui as TestUI).jsonOutput[0]).toMatchObject({
      requestId: attempt.requestId,
      error: {
        code: 'REQUEST_STATE_ERROR',
        message: expect.stringContaining('read'),
        suggestion: expect.stringContaining(attempt.requestId),
      },
    });
    expect(tmux.sends).toHaveLength(1);
    expect(getResponse).toHaveBeenCalledTimes(1);
    expect(fixture.service.getResponse(attempt.requestId)?.body).toBe('delivered');
  });

  it('correlates waiter-release failure after delivery without replaying the request', async () => {
    const root = temporaryDirectory('tmt-talk-release-failure-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const releaseWait = vi.fn(() => {
      throw new Error('waiter release failed after delivery');
    });
    const service = { ...fixture.service, releaseWait } as RequestService;
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'delivered'),
    });
    const ctx = createContext(root, { tmux, requestService: service });

    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.ERROR,
    });
    const attempt = onlyAttempt(fixture.service);
    expect((ctx.ui as TestUI).jsonOutput[0]).toMatchObject({
      requestId: attempt.requestId,
      error: {
        code: 'REQUEST_STATE_ERROR',
        suggestion: expect.stringContaining(attempt.requestId),
      },
    });
    expect(tmux.sends).toHaveLength(1);
    expect(releaseWait).toHaveBeenCalledTimes(1);
    expect(fixture.service.getResponse(attempt.requestId)?.body).toBe('delivered');
  });

  it('rejects a response read that crosses the deadline and performs no second read', async () => {
    const root = temporaryDirectory('tmt-talk-read-overrun-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    let clock = 20_000;
    const getResponse = vi.fn((requestId: string) => {
      const response = fixture.service.getResponse(requestId);
      clock += 20;
      return response;
    });
    const service = { ...fixture.service, getResponse } as RequestService;
    const tmux = createMockTmux({
      onSend: (message) =>
        submitFor(fixture.service, attemptFromInstruction(fixture.service, message), 'crossed'),
    });
    const ctx = createContext(root, {
      tmux,
      requestService: service,
      flags: { timeout: 0.01 },
      config: createConfig({ pollInterval: 0.001 }),
    });
    await expect(
      cmdTalk(ctx, talkRequest('claude', 'Hello'), {
        now: () => clock,
        sleep: async () => undefined,
      })
    ).rejects.toMatchObject({ exitCode: ExitCodes.TIMEOUT });
    expect(getResponse).toHaveBeenCalledTimes(1);
    expect(fixture.service.getResponse(onlyAttempt(fixture.service).requestId)?.body).toBe(
      'crossed'
    );
  });

  it('fails closed when request preparation cannot persist and does not send', async () => {
    const root = temporaryDirectory('tmt-talk-receipt-failure-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const service = {
      ...fixture.service,
      prepare: vi.fn(() => {
        throw new Error('receipt persistence failed');
      }),
    } as RequestService;
    const tmux = createMockTmux();
    const ctx = createContext(root, { tmux, requestService: service });
    const before = stateSnapshot(root);
    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.ERROR,
    });
    expect(tmux.sends).toHaveLength(0);
    expect(stateSnapshot(root)).toEqual(before);
  });

  it('refunds the prepared cadence reservation when receipt construction fails', async () => {
    const root = temporaryDirectory('tmt-talk-receipt-encode-failure-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const tmux = createMockTmux();
    const requestId = 'x'.repeat(300) as ReturnType<typeof crypto.randomUUID>;
    const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId);
    const ctx = createContext(root, { tmux });
    try {
      await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
        exitCode: ExitCodes.ERROR,
      });
      expect(tmux.sends).toHaveLength(0);
      const attempt = onlyAttempt(fixture.service);
      expect(attempt.status).toBe('definitely_failed');
      expect(attempt.waitActive).toBe(false);
      expect(stateSnapshot(root).responses).toEqual([]);
      expect(stateSnapshot(root).cadence).toEqual([expect.objectContaining({ reserved_count: 0 })]);
    } finally {
      uuid.mockRestore();
    }
  });

  it('releases only its waiter after an unexpected transport error', async () => {
    const root = temporaryDirectory('tmt-talk-cleanup-');
    const fixture = requestFixture(createPaths(root).databaseFile);
    const prepared = fixture.service.prepare({
      message: 'Existing request',
      requestId: 'other-request',
      endpoint: ENDPOINT,
      wait: true,
      expiresAtMs: Date.now() + 60 * 60 * 1000,
    });
    fixture.service.beginSend(prepared.attemptId);
    const tmux = createMockTmux();
    tmux.send = vi.fn(() => {
      throw new Error('unexpected send failure');
    });
    const ctx = createContext(root, { tmux });
    await expect(cmdTalk(ctx, talkRequest('claude', 'Hello'))).rejects.toMatchObject({
      exitCode: ExitCodes.ERROR,
    });
    expect(fixture.service.getAttempt(prepared.attemptId)?.waitActive).toBe(true);
    const newAttempt = fixture.service
      .listAttempts()
      .find((attempt) => attempt.requestId !== 'other-request');
    expect(newAttempt?.waitActive).toBe(false);
  });
});
