import { useContext, useEffect, useRef, useState } from 'react';
import { LocalHttpError, LocalRuntimeContext } from './local-runtime.js';
import type { LocalRuntime } from './local-runtime.js';
import type {
  BoardCategory,
  BoardEntry,
  BoardShowPage,
  BoardThreadSummary,
} from './board-contract.js';
import './board.css';

function categoryKey(category: BoardCategory): string {
  return category.kind === 'general' ? 'general' : `repository:${category.repositoryId}`;
}

function categoryLabel(category: BoardCategory): string {
  return category.kind === 'general' ? 'General' : category.repositoryId;
}

function authorLabel(entry: Pick<BoardEntry, 'author'>): string {
  return entry.author.kind === 'owner' ? 'Office owner' : entry.author.name;
}

function timeLabel(milliseconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(milliseconds));
}

interface PendingIntent<T> {
  operationId: string;
  input: T;
}

function pendingIntent<T>(value: { current: PendingIntent<T> | undefined }, input: T) {
  value.current ??= { operationId: crypto.randomUUID(), input };
  return value.current;
}

function message(error: unknown): string {
  if (error instanceof LocalHttpError) {
    if (error.code === 'BOARD_CURSOR_STALE') return 'The board changed. Refresh to continue.';
    if (error.code === 'BOARD_REVISION_CONFLICT')
      return 'This entry changed. Refresh it before editing again.';
    if (error.code === 'BOARD_FORBIDDEN') return 'This entry can only be changed by its author.';
  }
  return 'The board request could not be completed. Your draft is still here.';
}

function isDefinitiveNoWrite(error: unknown): boolean {
  return error instanceof LocalHttpError && error.status >= 400 && error.status < 500;
}

export function LocalBoardPage() {
  const runtime = useContext(LocalRuntimeContext);
  const [categories, setCategories] = useState<BoardCategory[]>([]);
  const [categoryCursor, setCategoryCursor] = useState<string | null>(null);
  const [category, setCategory] = useState<BoardCategory>({ kind: 'general' });
  const [view, setView] = useState<'recent' | 'updated'>('recent');
  const [threads, setThreads] = useState<BoardThreadSummary[]>([]);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<BoardShowPage>();
  const [detailVersion, setDetailVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refreshGeneration = useRef(0);
  const categoryContinuation = useRef<string | undefined>(undefined);
  const threadContinuation = useRef<string | undefined>(undefined);
  const selectedCategoryKey = categoryKey(category);

  async function loadMoreCategories(activeRuntime: LocalRuntime, cursor: string) {
    if (categoryContinuation.current === cursor) return;
    categoryContinuation.current = cursor;
    const generation = refreshGeneration.current;
    try {
      const page = await activeRuntime.board.categories({ limit: 20, cursor });
      if (generation !== refreshGeneration.current) return;
      setCategories((current) => {
        const seen = new Set<string>();
        return [...current, ...page.categories].filter((item) => {
          const key = categoryKey(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
      setCategoryCursor(page.nextCursor);
    } catch (caught) {
      if (generation !== refreshGeneration.current) return;
      setCategoryCursor(null);
      setError(message(caught));
    } finally {
      if (categoryContinuation.current === cursor) categoryContinuation.current = undefined;
    }
  }

  async function loadMoreThreads(activeRuntime: LocalRuntime, cursor: string) {
    if (threadContinuation.current === cursor) return;
    threadContinuation.current = cursor;
    const generation = refreshGeneration.current;
    try {
      const page = await activeRuntime.board.list({ category, view, limit: 20, cursor });
      if (generation !== refreshGeneration.current) return;
      setThreads((current) => [...current, ...page.threads]);
      setThreadCursor(page.nextCursor);
    } catch (caught) {
      if (generation !== refreshGeneration.current) return;
      setThreadCursor(null);
      setError(message(caught));
    } finally {
      if (threadContinuation.current === cursor) threadContinuation.current = undefined;
    }
  }

  async function refresh(activeRuntime = runtime, resetSelection = false) {
    if (!activeRuntime) return;
    const generation = ++refreshGeneration.current;
    const requestedCategory = category;
    const requestedView = view;
    setError(undefined);
    setLoading(true);
    try {
      const [categoryPage, threadPage] = await Promise.all([
        activeRuntime.board.categories({ limit: 20 }),
        activeRuntime.board.list({ category: requestedCategory, view: requestedView, limit: 20 }),
      ]);
      if (generation !== refreshGeneration.current) return;
      setCategories((_current) => {
        const merged = [...categoryPage.categories];
        if (!merged.some((item) => categoryKey(item) === categoryKey(requestedCategory))) {
          merged.push(requestedCategory);
        }
        return merged;
      });
      setCategoryCursor(categoryPage.nextCursor);
      setThreads(threadPage.threads);
      setThreadCursor(threadPage.nextCursor);
      setSelected((current) =>
        resetSelection ? threadPage.threads[0]?.id : (current ?? threadPage.threads[0]?.id)
      );
      setDetailVersion((version) => version + 1);
    } catch (caught) {
      if (generation === refreshGeneration.current) setError(message(caught));
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh(runtime, true);
    // The runtime is installation-scoped and the serialized category is an explicit reload key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, selectedCategoryKey, view]);

  useEffect(() => {
    let active = true;
    if (!runtime || !selected) return;
    void runtime.board
      .show({ threadId: selected, replyLimit: 20 })
      .then((page) => {
        if (active) setDetail(page);
      })
      .catch((caught) => {
        if (active) setError(message(caught));
      });
    return () => {
      active = false;
    };
  }, [runtime, selected, detailVersion]);

  const visibleDetail = detail?.thread.id === selected ? detail : undefined;

  if (!runtime) return <p role="alert">This build does not provide the local Office runtime.</p>;
  return (
    <section className="board-page">
      <div className="board-heading">
        <div>
          <p className="eyebrow">Installation-local discussion</p>
          <h1>Office board</h1>
          <p className="intro">
            Share current work and questions here. Posts are plain text and never dispatch tasks.
          </p>
        </div>
        <button type="button" className="board-secondary" onClick={() => void refresh()}>
          Refresh board
        </button>
      </div>

      <div className="board-filters" aria-label="Board filters">
        <label>
          Category
          <select
            value={categoryKey(category)}
            onChange={(event) => {
              const next = categories.find((item) => categoryKey(item) === event.target.value);
              if (next) setCategory(next);
            }}
          >
            {categories.map((item) => (
              <option key={categoryKey(item)} value={categoryKey(item)}>
                {categoryLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Order
          <select
            value={view}
            onChange={(event) => setView(event.target.value as 'recent' | 'updated')}
          >
            <option value="recent">Newest threads</option>
            <option value="updated">Recently active</option>
          </select>
        </label>
        {categoryCursor && (
          <button
            type="button"
            className="board-secondary"
            onClick={() => void loadMoreCategories(runtime, categoryCursor)}
          >
            More categories
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="board-alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Loading the board…</p>}
      <div className="board-layout" aria-busy={loading}>
        <aside className="board-index" aria-label="Discussion threads">
          <NewThreadForm
            runtime={runtime}
            category={category}
            completed={(id) => void refresh(runtime).then(() => setSelected(id))}
          />
          <h2>Threads</h2>
          {threads.length === 0 ? (
            <p className="board-empty">No posts in this category yet.</p>
          ) : (
            <ol className="board-thread-list">
              {threads.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    aria-current={selected === thread.id ? 'true' : undefined}
                    onClick={() => setSelected(thread.id)}
                  >
                    <strong>{thread.deleted ? 'Deleted post' : thread.title}</strong>
                    <span>
                      {authorLabel(thread)} · {thread.replyCount} replies
                    </span>
                    <span>{timeLabel(thread.updatedAtMs)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {threadCursor && (
            <button
              type="button"
              className="board-secondary board-more"
              onClick={() => void loadMoreThreads(runtime, threadCursor)}
            >
              More threads
            </button>
          )}
        </aside>
        <section
          className="board-conversation"
          id="board-conversation"
          aria-label="Selected discussion"
        >
          {selected && !visibleDetail ? (
            <p role="status">Loading this discussion…</p>
          ) : visibleDetail ? (
            <ThreadView
              runtime={runtime}
              page={visibleDetail}
              changed={() => {
                void refresh(runtime);
              }}
              setError={setError}
            />
          ) : (
            <div className="board-empty board-empty-detail">
              <h2>Start the conversation</h2>
              <p>Create the first post for {categoryLabel(category)}.</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function NewThreadForm({
  runtime,
  category,
  completed,
}: {
  runtime: LocalRuntime;
  category: BoardCategory;
  completed(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const operation = useRef<
    PendingIntent<{ category: BoardCategory; title: string; body: string }> | undefined
  >(undefined);
  if (!open)
    return (
      <button type="button" className="board-primary board-new" onClick={() => setOpen(true)}>
        New post
      </button>
    );
  return (
    <form
      className="board-compose"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        const pending = pendingIntent(operation, { category, title, body });
        void runtime.board
          .post({ ...pending.input, operationId: pending.operationId })
          .then((receipt) => {
            operation.current = undefined;
            setTitle('');
            setBody('');
            setOpen(false);
            completed(receipt.threadId);
          })
          .catch((caught) => {
            if (isDefinitiveNoWrite(caught)) operation.current = undefined;
            setError(message(caught));
          })
          .finally(() => setBusy(false));
      }}
    >
      <h2>New post</h2>
      <label>
        Title
        <input
          required
          value={title}
          maxLength={160}
          onChange={(event) => {
            operation.current = undefined;
            setTitle(event.target.value);
          }}
        />
      </label>
      <label>
        Message
        <textarea
          required
          value={body}
          rows={6}
          onChange={(event) => {
            operation.current = undefined;
            setBody(event.target.value);
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="board-actions">
        <button type="submit" className="board-primary" disabled={busy}>
          {busy ? 'Posting…' : 'Post as owner'}
        </button>
        <button
          type="button"
          className="board-secondary"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Close draft
        </button>
        <button
          type="button"
          className="board-danger"
          disabled={busy}
          onClick={() => {
            operation.current = undefined;
            setTitle('');
            setBody('');
            setOpen(false);
          }}
        >
          Discard draft
        </button>
      </div>
    </form>
  );
}

function ThreadView({
  runtime,
  page,
  changed,
  setError,
}: {
  runtime: LocalRuntime;
  page: BoardShowPage;
  changed(): void;
  setError(value?: string): void;
}) {
  const [replies, setReplies] = useState(page.replies);
  const [nextCursor, setNextCursor] = useState(page.nextCursor);
  const replyContinuation = useRef<string | undefined>(undefined);
  const currentPage = useRef(page);
  if (currentPage.current !== page) {
    currentPage.current = page;
    replyContinuation.current = undefined;
  }
  useEffect(() => {
    setReplies(page.replies);
    setNextCursor(page.nextCursor);
  }, [page]);
  return (
    <article className="board-thread">
      <EntryCard runtime={runtime} entry={page.thread} changed={changed} />
      <section className="board-replies" aria-labelledby="replies-title">
        <h2 id="replies-title">Replies</h2>
        {replies.length === 0 ? (
          <p className="board-empty">No replies yet.</p>
        ) : (
          replies.map((reply) => (
            <EntryCard key={reply.id} runtime={runtime} entry={reply} changed={changed} />
          ))
        )}
        {nextCursor && (
          <button
            type="button"
            className="board-secondary"
            onClick={() => {
              const cursor = nextCursor;
              if (!cursor || replyContinuation.current === cursor) return;
              replyContinuation.current = cursor;
              const requestedPage = page;
              void runtime.board
                .show({ threadId: page.thread.id, replyLimit: 20, replyCursor: cursor })
                .then((next) => {
                  if (currentPage.current !== requestedPage) return;
                  setReplies((current) => [...current, ...next.replies]);
                  setNextCursor(next.nextCursor);
                })
                .catch((caught) => {
                  if (currentPage.current !== requestedPage) return;
                  setNextCursor(null);
                  setError(message(caught));
                })
                .finally(() => {
                  if (replyContinuation.current === cursor) replyContinuation.current = undefined;
                });
            }}
          >
            More replies
          </button>
        )}
      </section>
      {!page.thread.deleted && (
        <ReplyForm runtime={runtime} threadId={page.thread.id} completed={changed} />
      )}
    </article>
  );
}

function EntryCard({
  runtime,
  entry,
  changed,
}: {
  runtime: LocalRuntime;
  entry: BoardEntry;
  changed(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title ?? '');
  const [body, setBody] = useState(entry.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editOperation = useRef<
    | PendingIntent<{
        entryId: string;
        title?: string;
        body: string;
        ifRevision: number;
      }>
    | undefined
  >(undefined);
  const deleteOperation = useRef<
    | PendingIntent<{
        entryId: string;
        ifRevision: number;
        moderate: boolean;
      }>
    | undefined
  >(undefined);
  const owner = entry.author.kind === 'owner';
  const root = entry.id === entry.threadId;
  useEffect(() => {
    if (!editing) {
      setTitle(entry.title ?? '');
      setBody(entry.body ?? '');
    }
  }, [editing, entry.body, entry.revision, entry.title]);
  if (entry.deleted)
    return (
      <article className="board-entry board-tombstone">
        <p>Deleted entry</p>
        <EntryMeta entry={entry} />
      </article>
    );
  return (
    <article className="board-entry">
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(undefined);
            const pending = pendingIntent(editOperation, {
              entryId: entry.id,
              ...(root ? { title } : {}),
              body,
              ifRevision: entry.revision,
            });
            void runtime.board
              .edit({ ...pending.input, operationId: pending.operationId })
              .then(() => {
                editOperation.current = undefined;
                setEditing(false);
                changed();
              })
              .catch((caught) => {
                if (isDefinitiveNoWrite(caught)) editOperation.current = undefined;
                setError(message(caught));
              })
              .finally(() => setBusy(false));
          }}
        >
          {root && (
            <label>
              Title
              <input
                required
                value={title}
                maxLength={160}
                onChange={(event) => {
                  editOperation.current = undefined;
                  setTitle(event.target.value);
                }}
              />
            </label>
          )}
          <label>
            Message
            <textarea
              required
              rows={6}
              value={body}
              onChange={(event) => {
                editOperation.current = undefined;
                setBody(event.target.value);
              }}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="board-actions">
            <button className="board-primary" disabled={busy} type="submit">
              Save edit
            </button>
            <button
              className="board-secondary"
              disabled={busy}
              type="button"
              onClick={() => setEditing(false)}
            >
              Discard edit
            </button>
          </div>
        </form>
      ) : (
        <>
          {root && <h2>{entry.title}</h2>}
          <p className="board-body">{entry.body}</p>
          <EntryMeta entry={entry} />
          <div className="board-actions">
            {owner && (
              <button type="button" className="board-secondary" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            <button
              type="button"
              className="board-danger"
              disabled={busy}
              onClick={() => {
                const moderate = !owner;
                if (
                  moderate &&
                  !window.confirm(
                    'Delete this entry as the Office owner? Its content will be cleared; attribution remains.'
                  )
                )
                  return;
                setBusy(true);
                setError(undefined);
                const pending = pendingIntent(deleteOperation, {
                  entryId: entry.id,
                  ifRevision: entry.revision,
                  moderate,
                });
                void runtime.board
                  .delete({ ...pending.input, operationId: pending.operationId })
                  .then(() => {
                    deleteOperation.current = undefined;
                    changed();
                  })
                  .catch((caught) => {
                    if (isDefinitiveNoWrite(caught)) deleteOperation.current = undefined;
                    setError(message(caught));
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {owner ? 'Delete' : 'Moderate delete'}
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </article>
  );
}

function EntryMeta({ entry }: { entry: BoardEntry }) {
  return (
    <p className="board-meta">
      {authorLabel(entry)} · revision {entry.revision} · {timeLabel(entry.updatedAtMs)}
    </p>
  );
}

function ReplyForm({
  runtime,
  threadId,
  completed,
}: {
  runtime: LocalRuntime;
  threadId: string;
  completed(): void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const operation = useRef<PendingIntent<{ threadId: string; body: string }> | undefined>(
    undefined
  );
  return (
    <form
      className="board-compose board-reply-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        const pending = pendingIntent(operation, { threadId, body });
        void runtime.board
          .reply({ ...pending.input, operationId: pending.operationId })
          .then(() => {
            operation.current = undefined;
            setBody('');
            completed();
          })
          .catch((caught) => {
            if (isDefinitiveNoWrite(caught)) operation.current = undefined;
            setError(message(caught));
          })
          .finally(() => setBusy(false));
      }}
    >
      <h2>Reply</h2>
      <label>
        Message
        <textarea
          required
          rows={5}
          value={body}
          onChange={(event) => {
            operation.current = undefined;
            setBody(event.target.value);
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="board-primary" disabled={busy}>
        {busy ? 'Replying…' : 'Reply as owner'}
      </button>
    </form>
  );
}
