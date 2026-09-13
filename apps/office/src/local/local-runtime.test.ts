import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockConflict } from '../blocks/block-contract.js';
import { createBlockState } from '../blocks/block-state.js';
import { startLocalRuntime } from './local-runtime.js';

const token = 'a'.repeat(43);
const block = {
  exists: true as const,
  blockId: '11111111-1111-4111-8111-111111111111',
  identityId: '22222222-2222-4222-8222-222222222222',
  identityName: 'Alice',
  revision: 1,
  objects: [],
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
    await expect(runtime.blocks.apply(block.blockId, 1, [])).rejects.toBeInstanceOf(BlockConflict);
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
    const post = fetch.mock.calls[1];
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
    const state = createBlockState(runtime.blocks, block.blockId);
    await vi.advanceTimersByTimeAsync(0);
    state.edit([{ asset: 'plant', x: 2, y: 3, rotation: 0 }]);
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
    expect(state.getSnapshot().draft?.objects[0]?.asset).toBe('plant');
    expect(state.getSnapshot().error).toBeNull();
    expect(activeSignal?.aborted).toBe(false);
    state.dispose();
    expect(activeSignal?.aborted).toBe(true);
    runtime.dispose();
  });
});
