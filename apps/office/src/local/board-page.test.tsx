import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockPort } from '../blocks/block-contract.js';
import type { LocalRuntime } from './local-runtime.js';
import { LocalRuntimeContext } from './local-runtime.js';
import { LocalBoardPage } from './board-page.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const replyId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const category = { kind: 'general' } as const;
const owner = { kind: 'owner' } as const;
const identity = {
  kind: 'identity',
  identityId: '44444444-4444-4444-8444-444444444444',
  name: 'Alice',
} as const;
const thread = {
  id: threadId,
  threadId,
  category,
  author: owner,
  revision: 1,
  deleted: false,
  createdAtMs: 1,
  updatedAtMs: 2,
  title: 'Current work',
  body: '<script>plain text</script>',
};
const reply = {
  id: replyId,
  threadId,
  category,
  author: identity,
  revision: 1,
  deleted: false,
  createdAtMs: 2,
  updatedAtMs: 2,
  body: 'Question from Alice',
};

function runtime(): LocalRuntime {
  const blocks: BlockPort = {
    watch: () => () => undefined,
    apply: async () => ({ revision: 1, objects: [], updatedAtMs: 1 }),
  };
  const { body: _body, ...threadSummary } = thread;
  return {
    blocks,
    list: async () => [],
    dispose: () => undefined,
    board: {
      categories: vi.fn(async () => ({
        categories: [category],
        nextCursor: null,
        boardRevision: 2,
      })),
      list: vi.fn(async () => ({
        threads: [
          {
            ...threadSummary,
            replyCount: 1,
            activitySequence: 2,
          },
        ],
        nextCursor: null,
        boardRevision: 2,
      })),
      show: vi.fn(async () => ({ thread, replies: [reply], nextCursor: null, boardRevision: 2 })),
      post: vi.fn(async () => ({
        entryId: threadId,
        threadId,
        revision: 1,
        created: true,
        operationId,
      })),
      reply: vi.fn(async () => ({
        entryId: replyId,
        threadId,
        revision: 1,
        created: true,
        operationId,
      })),
      edit: vi.fn(async () => ({ entryId: threadId, revision: 2, changed: true, operationId })),
      delete: vi.fn(async () => ({
        entryId: replyId,
        revision: 2,
        deleted: true as const,
        changed: true,
        moderated: true,
        operationId,
      })),
    },
  };
}

function mount(active: LocalRuntime) {
  return render(
    <LocalRuntimeContext value={active}>
      <LocalBoardPage />
    </LocalRuntimeContext>
  );
}

describe('local Office board', () => {
  beforeEach(() => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId);
  });

  it('renders hostile text literally and keeps owner and moderation actions distinct', async () => {
    const active = runtime();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = mount(active);
    expect(await screen.findByRole('heading', { name: 'Current work' })).toBeTruthy();
    expect(screen.getByText('<script>plain text</script>')).toBeTruthy();
    expect(view.container.querySelector('script')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Moderate delete' }));
    await waitFor(() =>
      expect(active.board.delete).toHaveBeenCalledWith({
        entryId: replyId,
        ifRevision: 1,
        moderate: true,
        operationId,
      })
    );
  });

  it('posts as the browser owner with one retained operation ID and no actor field', async () => {
    const active = runtime();
    mount(active);
    await screen.findByRole('heading', { name: 'Current work' });
    await userEvent.click(screen.getByRole('button', { name: 'New post' }));
    await userEvent.type(screen.getByLabelText('Title'), 'A discovery');
    await userEvent.type(screen.getAllByLabelText('Message')[0]!, 'Useful details');
    await userEvent.click(screen.getByRole('button', { name: 'Post as owner' }));
    await waitFor(() =>
      expect(active.board.post).toHaveBeenCalledWith({
        category,
        title: 'A discovery',
        body: 'Useful details',
        operationId,
      })
    );
    expect((active.board.post as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toHaveProperty(
      'actor'
    );
  });

  it('retries an unchanged draft with the exact same operation ID', async () => {
    const retryOperationId = '55555555-5555-4555-8555-555555555555';
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReset()
      .mockReturnValueOnce(operationId)
      .mockReturnValue(retryOperationId);
    const active = runtime();
    vi.mocked(active.board.post)
      .mockRejectedValueOnce(new TypeError('temporarily disconnected'))
      .mockResolvedValueOnce({
        entryId: threadId,
        threadId,
        revision: 1,
        created: true,
        operationId,
      });
    mount(active);
    await screen.findByRole('heading', { name: 'Current work' });
    await userEvent.click(screen.getByRole('button', { name: 'New post' }));
    await userEvent.type(screen.getByLabelText('Title'), 'Retry me');
    await userEvent.type(screen.getAllByLabelText('Message')[0]!, 'Same body');
    await userEvent.click(screen.getByRole('button', { name: 'Post as owner' }));
    expect((await screen.findByRole('alert')).textContent).toContain('draft is still here');
    await userEvent.click(screen.getByRole('button', { name: 'Post as owner' }));
    await waitFor(() => expect(active.board.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(active.board.post).mock.calls.map(([input]) => input.operationId)).toEqual([
      operationId,
      operationId,
    ]);
  });
});
