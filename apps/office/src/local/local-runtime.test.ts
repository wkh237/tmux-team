import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockConflict, builtinFurniture } from '../blocks/block-contract.js';
import { createBlockState } from '../blocks/block-state.js';
import { startLocalRuntime } from './local-runtime.js';
import { PROFILE_CATALOG, ProfileConflict } from '../profiles/profile-contract.js';

const token = 'a'.repeat(43);
const block = {
  exists: true as const,
  blockId: '11111111-1111-4111-8111-111111111111',
  identityId: '22222222-2222-4222-8222-222222222222',
  identityName: 'Alice',
  revision: 1,
  layout: { version: 2 as const, objects: [] },
  resolutions: [],
  updatedAtMs: 1,
};

describe('local Office runtime', () => {
  beforeEach(() => history.replaceState(null, '', `/local#token=${token}`));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('moves the fragment token to memory and authenticates bounded reads', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([block]), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const runtime = startLocalRuntime(window.location);
    expect(location.hash).toBe('');
    await expect(runtime.list()).resolves.toEqual([block]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/local/blocks',
      expect.objectContaining({ headers: { Authorization: `Bearer ${token}` } })
    );
    runtime.dispose();
  });

  it('rejects missing sessions and preserves revision conflicts', async () => {
    history.replaceState(null, '', '/local');
    expect(() => startLocalRuntime(window.location)).toThrow('session is missing');
    history.replaceState(null, '', `/local#token=${token}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"REVISION_CONFLICT"}', { status: 409 }))
    );
    const runtime = startLocalRuntime(window.location);
    await expect(runtime.blocks.apply(block.identityId, 1, [])).rejects.toBeInstanceOf(
      BlockConflict
    );
    runtime.dispose();
  });

  it('reads an absent room without writing and creates it with identity-targeted revision zero', async () => {
    vi.useFakeTimers();
    const absent = { ...block, exists: false, blockId: null, revision: 0, updatedAtMs: 0 };
    const fetch = vi.fn(
      async (_path: string, init?: RequestInit) =>
        new Response(JSON.stringify(init?.method === 'PUT' ? { ...block, changed: true } : absent))
    );
    vi.stubGlobal('fetch', fetch);
    const runtime = startLocalRuntime(window.location);
    const changed = vi.fn();
    const stop = runtime.blocks.watch(block.identityId, changed, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledExactlyOnceWith(null);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
    await expect(runtime.blocks.apply(block.identityId, 0, [])).resolves.toMatchObject({
      revision: 1,
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/v1/local/identities/${block.identityId}/block`);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      expectedRevision: 0,
      layout: { version: 2, objects: [] },
    });
    stop();
    runtime.dispose();
  });

  it('rejects an absent entry in the persisted list and a save for another identity', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([{ ...block, exists: false, blockId: null, revision: 0, updatedAtMs: 0 }])
        )
    );
    vi.stubGlobal('fetch', fetch);
    const runtime = startLocalRuntime(window.location);
    await expect(runtime.list()).rejects.toThrow();
    fetch.mockImplementation(async () => new Response(JSON.stringify({ ...block, changed: true })));
    await expect(
      runtime.blocks.apply('33333333-3333-4333-8333-333333333333', 0, [])
    ).rejects.toThrow('Unexpected block identity');
    runtime.dispose();
  });

  it('resolves shared room props once in batches of at most sixteen unique digests', async () => {
    const digests = Array.from(
      { length: 18 },
      (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`
    );
    const fetch = vi.fn(
      async (_path: string, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            catalogRevision: 0,
            packs: [],
            unavailable: JSON.parse(String(init?.body)).digests,
          })
        )
    );
    vi.stubGlobal('fetch', fetch);
    const runtime = startLocalRuntime(window.location);
    const props = [...digests, digests[0]!].map((digest) => ({
      ...builtinFurniture('desk', 1, 1, 0),
      prop: `${digest}/desk`,
    }));
    await runtime.resolveProps(props);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body)).digests])
    ).toEqual([
      ['/api/v1/local/props/resolve', digests.slice(0, 16)],
      ['/api/v1/local/props/resolve', digests.slice(16)],
    ]);
    runtime.dispose();
  });

  it('uses the same in-memory browser credential for typed board operations', async () => {
    const operationId = '33333333-3333-4333-8333-333333333333';
    const fetch = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.endsWith('/categories/list'))
        return new Response(
          JSON.stringify({
            categories: [{ kind: 'general' }],
            nextCursor: null,
            boardRevision: 0,
          }),
          { status: 200 }
        );
      if (path.endsWith('/threads/list'))
        return new Response(JSON.stringify({ threads: [], nextCursor: null, boardRevision: 0 }), {
          status: 200,
        });
      return new Response(
        JSON.stringify({
          entryId: '11111111-1111-4111-8111-111111111111',
          threadId: '11111111-1111-4111-8111-111111111111',
          revision: 1,
          created: true,
          operationId,
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetch);
    const runtime = startLocalRuntime(window.location);
    await expect(runtime.board.categories()).resolves.toMatchObject({ boardRevision: 0 });
    await runtime.board.list({
      category: { kind: 'general' },
      author: { kind: 'identity', identityId: '22222222-2222-4222-8222-222222222222' },
    });
    await runtime.board.post({
      category: { kind: 'general' },
      title: 'Status',
      body: 'Plain text',
      operationId,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/local/board/categories/list',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
    );
    const list = fetch.mock.calls[1];
    expect(list?.[0]).toBe('/api/v1/local/board/threads/list');
    expect(JSON.parse(String(list?.[1]?.body)).author).toEqual({
      kind: 'identity',
      identityId: '22222222-2222-4222-8222-222222222222',
    });
    const post = fetch.mock.calls[2];
    expect(post?.[0]).toBe('/api/v1/local/board/threads');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      category: { kind: 'general' },
      title: 'Status',
      body: 'Plain text',
      operationId,
    });
    expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty('actor');
    runtime.dispose();
  });

  it('reads and conditionally writes typed local profiles with the same browser credential', async () => {
    const snapshot = {
      identityId: block.identityId,
      identityName: 'Alice',
      exists: false,
      revision: 0,
      profile: {
        displayLabel: '',
        description: '',
        appearance: {
          hairStyle: 'short',
          hairColor: 'ink',
          skinTone: 'medium',
          shirtColor: 'blue',
          shirtMark: 'AI',
        },
      },
      updatedAtMs: null,
      catalog: PROFILE_CATALOG,
    } as const;
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PUT')
        return new Response('{"error":"REVISION_CONFLICT"}', { status: 409 });
      return new Response(
        JSON.stringify(path.endsWith('/profiles') ? [{ ...snapshot, online: false }] : snapshot),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetch);
    const runtime = startLocalRuntime(window.location);
    await expect(runtime.profiles.list()).resolves.toEqual([{ ...snapshot, online: false }]);
    await expect(runtime.profiles.show(block.identityId)).resolves.toEqual(snapshot);
    await expect(
      runtime.profiles.apply(block.identityId, 0, snapshot.profile)
    ).rejects.toBeInstanceOf(ProfileConflict);
    expect(fetch.mock.calls[2]?.[0]).toBe(`/api/v1/local/profiles/${block.identityId}`);
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      expectedRevision: 0,
      profile: snapshot.profile,
    });
    runtime.dispose();
  });

  it('loads the bounded avatar catalog once through the authenticated runtime port', async () => {
    const value = { catalogRevision: 0, packs: [] };
    const fetch = vi.fn(async () => new Response(JSON.stringify(value), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const runtime = startLocalRuntime(window.location);
    await expect(runtime.avatars.list()).resolves.toEqual(value);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/local/avatar-catalog',
      expect.objectContaining({ headers: { Authorization: `Bearer ${token}` } })
    );
    runtime.dispose();
  });

  it('distinguishes an unavailable avatar from a profile revision conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"AVATAR_UNAVAILABLE"}', { status: 409 }))
    );
    const runtime = startLocalRuntime(window.location);
    const profile = {
      displayLabel: '',
      description: '',
      appearance: {
        hairStyle: 'short' as const,
        hairColor: 'ink' as const,
        skinTone: 'medium' as const,
        shirtColor: 'blue' as const,
        shirtMark: '',
      },
    };
    await expect(runtime.profiles.apply(block.identityId, 0, profile)).rejects.toThrow(
      'selected avatar is no longer installed'
    );
    runtime.dispose();
  });

  it('preserves drafts through transient backoff and aborts an active poll on disposal', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let activeSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init?: RequestInit) => {
        calls += 1;
        activeSignal = init?.signal ?? undefined;
        if (calls === 1) return new Response(JSON.stringify(block), { status: 200 });
        if (calls < 4) throw new TypeError('temporarily disconnected');
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        });
      })
    );
    const runtime = startLocalRuntime(window.location);
    const state = createBlockState(runtime.blocks, block.identityId);
    await vi.advanceTimersByTimeAsync(0);
    state.edit([builtinFurniture('plant', 2, 3, 0)]);
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
    expect(state.getSnapshot().draft?.objects[0]?.prop).toContain('/plant');
    expect(state.getSnapshot().error).toBeNull();
    expect(activeSignal?.aborted).toBe(false);
    state.dispose();
    expect(activeSignal?.aborted).toBe(true);
    runtime.dispose();
  });
});
