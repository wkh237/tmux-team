import { createContext } from 'react';
import { BlockConflict, defaultCatalog, validLayout } from '../blocks/block-contract.js';
import type { Block, BlockPort, Furniture } from '../blocks/block-contract.js';
import { BUILTIN_DIGEST, decodePropPack } from '../props/prop-contract.js';
import type { CatalogPack } from '../props/prop-contract.js';
import {
  decodeBoardList,
  decodeBoardShow,
  decodeCategoryPage,
  decodeDeleteReceipt,
  decodeEditReceipt,
  decodePostReceipt,
  decodeReplyReceipt,
} from './board-contract.js';
import type {
  BoardCategory,
  BoardCategoryPage,
  BoardCreateReceipt,
  BoardDeleteReceipt,
  BoardEditReceipt,
  BoardListPage,
  BoardShowPage,
} from './board-contract.js';
import {
  decodeProfileProjection,
  decodeProfileMutation,
  decodeProfileSnapshot,
  ProfileConflict,
} from '../profiles/profile-contract.js';
import type { Profile, ProfilePort } from '../profiles/profile-contract.js';

export type BoardAuthorFilter = { kind: 'owner' } | { kind: 'identity'; identityId: string };

export interface LocalBlockProjection {
  exists: true;
  blockId: string;
  identityId: string;
  identityName: string;
  revision: number;
  layout: { version: 2; objects: Furniture[] };
  resolutions: unknown[];
  updatedAtMs: number;
  changed?: boolean;
}

export interface LocalRuntime {
  blocks: BlockPort;
  profiles: ProfilePort;
  board: LocalBoardPort;
  list(): Promise<LocalBlockProjection[]>;
  preview(previewId: string): Promise<CatalogPack>;
  dispose(): void;
}

export interface BoardListInput {
  category: BoardCategory;
  view?: 'recent' | 'updated';
  author?: BoardAuthorFilter;
  sinceMs?: number;
  limit?: number;
  cursor?: string;
}

export interface LocalBoardPort {
  categories(input?: { limit?: number; cursor?: string }): Promise<BoardCategoryPage>;
  list(input: BoardListInput): Promise<BoardListPage>;
  show(input: {
    threadId: string;
    replyLimit?: number;
    replyCursor?: string;
  }): Promise<BoardShowPage>;
  post(input: {
    category: BoardCategory;
    title: string;
    body: string;
    operationId: string;
  }): Promise<BoardCreateReceipt>;
  reply(input: {
    threadId: string;
    body: string;
    operationId: string;
  }): Promise<BoardCreateReceipt>;
  edit(input: {
    entryId: string;
    title?: string;
    body?: string;
    ifRevision: number;
    operationId: string;
  }): Promise<BoardEditReceipt>;
  delete(input: {
    entryId: string;
    ifRevision: number;
    moderate: boolean;
    operationId: string;
  }): Promise<BoardDeleteReceipt>;
}

export const LocalRuntimeContext = createContext<LocalRuntime | undefined>(undefined);

export class LocalHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string
  ) {
    super(
      code ? `Local Office request failed (${code}).` : `Local Office request failed (${status}).`
    );
  }
}

export function startLocalRuntime(location: Location): LocalRuntime {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Office session is missing.');
  const controllers = new Set<AbortController>();
  let disposed = false;
  async function jsonRequest(
    path: string,
    init?: RequestInit,
    lifetime?: AbortSignal
  ): Promise<{ response: Response; value: unknown }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (lifetime?.aborted || disposed) controller.abort();
    else lifetime?.addEventListener('abort', abort, { once: true });
    const timeout = window.setTimeout(abort, 5_000);
    controllers.add(controller);
    try {
      const response = await fetch(path, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      const value: unknown = await response.json();
      return { response, value };
    } finally {
      window.clearTimeout(timeout);
      lifetime?.removeEventListener('abort', abort);
      controllers.delete(controller);
    }
  }
  function checked<T>(response: Response, value: unknown, decode: (value: unknown) => T): T {
    if (!response.ok) {
      const code =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>).error
          : undefined;
      throw new LocalHttpError(response.status, typeof code === 'string' ? code : undefined);
    }
    return decode(value);
  }
  async function boardRequest<T>(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body: unknown,
    decode: (value: unknown) => T
  ): Promise<T> {
    const { response, value } = await jsonRequest(path, {
      method,
      body: JSON.stringify(body),
    });
    return checked(response, value, decode);
  }
  function decode(value: unknown, editing = false): LocalBlockProjection {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid block.');
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !==
      (editing
        ? 'blockId,changed,exists,identityId,identityName,layout,resolutions,revision,updatedAtMs'
        : 'blockId,exists,identityId,identityName,layout,resolutions,revision,updatedAtMs')
    )
      throw new Error('Invalid block.');
    const block = record as unknown as LocalBlockProjection;
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (
      block.exists !== true ||
      !uuidV4.test(block.blockId) ||
      !uuidV4.test(block.identityId) ||
      typeof block.identityName !== 'string' ||
      block.identityName.length === 0 ||
      !Number.isSafeInteger(block.revision) ||
      block.revision <= 0 ||
      !Number.isSafeInteger(block.updatedAtMs) ||
      block.updatedAtMs <= 0 ||
      !block.layout ||
      block.layout.version !== 2 ||
      !validLayout(block.layout.objects) ||
      !Array.isArray(block.resolutions) ||
      block.resolutions.length !== block.layout.objects.length ||
      (editing && typeof block.changed !== 'boolean')
    )
      throw new Error('Invalid block.');
    return block;
  }
  async function catalogFor(objects: Furniture[], lifetime?: AbortSignal): Promise<CatalogPack[]> {
    const digests = Array.from(
      new Set(
        objects
          .map((item) => item.prop.split('/')[0]!)
          .filter((digest) => digest !== BUILTIN_DIGEST)
      )
    );
    if (digests.length === 0) return defaultCatalog();
    const { response, value } = await jsonRequest(
      '/api/v1/local/props/resolve',
      { method: 'POST', body: JSON.stringify({ digests }) },
      lifetime
    );
    return checked(response, value, (candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
        throw new Error('Invalid prop catalog.');
      const record = candidate as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(',') !== 'catalogRevision,packs,unavailable' ||
        !Number.isSafeInteger(record.catalogRevision) ||
        !Array.isArray(record.packs) ||
        !Array.isArray(record.unavailable)
      )
        throw new Error('Invalid prop catalog.');
      const packs = record.packs.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new Error('Invalid prop catalog entry.');
        const item = entry as Record<string, unknown>;
        if (
          Object.keys(item).sort().join(',') !== 'digest,pack' ||
          typeof item.digest !== 'string' ||
          !/^sha256:[0-9a-f]{64}$/.test(item.digest)
        )
          throw new Error('Invalid prop catalog entry.');
        return { digest: item.digest, pack: decodePropPack(item.pack) };
      });
      if (
        !record.unavailable.every(
          (digest): digest is string =>
            typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest)
        )
      )
        throw new Error('Invalid unavailable prop catalog entry.');
      const returned = [...packs.map((pack) => pack.digest), ...record.unavailable];
      if (
        new Set(returned).size !== returned.length ||
        returned.length !== digests.length ||
        returned.some((digest) => !digests.includes(digest))
      )
        throw new Error('Invalid prop catalog resolution.');
      return [...defaultCatalog(), ...packs];
    });
  }
  const blocks: BlockPort = {
    watch(blockId, changed, failed) {
      let active = true;
      let delay = 2_000;
      let timer: number | undefined;
      const lifetime = new AbortController();
      const poll = async () => {
        if (!active || disposed) return;
        try {
          const { response, value } = await jsonRequest(
            `/api/v1/local/blocks/${encodeURIComponent(blockId)}`,
            undefined,
            lifetime.signal
          );
          if (!response.ok) throw new LocalHttpError(response.status);
          const block = decode(value);
          const catalog = await catalogFor(block.layout.objects, lifetime.signal);
          if (!active || disposed) return;
          changed({
            revision: block.revision,
            objects: block.layout.objects,
            updatedAtMs: block.updatedAtMs,
            catalog,
          });
          delay = 2_000;
        } catch (error) {
          if (!active || disposed) return;
          if (error instanceof LocalHttpError && [401, 403, 404, 421].includes(error.status)) {
            active = false;
            failed();
            lifetime.abort();
            return;
          }
          delay = Math.min(delay * 2, 30_000);
        }
        if (active && !disposed) timer = window.setTimeout(poll, delay);
      };
      void poll();
      return () => {
        active = false;
        lifetime.abort();
        if (timer !== undefined) window.clearTimeout(timer);
      };
    },
    async apply(blockId, revision, objects): Promise<Block> {
      const { response, value } = await jsonRequest(
        `/api/v1/local/blocks/${encodeURIComponent(blockId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ expectedRevision: revision, layout: { version: 2, objects } }),
        }
      );
      if (response.status === 409) throw new BlockConflict();
      if (!response.ok) throw new Error(`Local Office save failed (${response.status}).`);
      const block = decode(value, true);
      const catalog = await catalogFor(block.layout.objects);
      return {
        revision: block.revision,
        objects: block.layout.objects,
        updatedAtMs: block.updatedAtMs,
        catalog,
      };
    },
  };
  const board: LocalBoardPort = {
    categories(input = {}) {
      return boardRequest('/api/v1/local/board/categories/list', 'POST', input, decodeCategoryPage);
    },
    list(input) {
      return boardRequest('/api/v1/local/board/threads/list', 'POST', input, decodeBoardList);
    },
    show(input) {
      return boardRequest('/api/v1/local/board/threads/show', 'POST', input, decodeBoardShow);
    },
    post(input) {
      return boardRequest('/api/v1/local/board/threads', 'POST', input, decodePostReceipt);
    },
    reply({ threadId, ...input }) {
      return boardRequest(
        `/api/v1/local/board/threads/${encodeURIComponent(threadId)}/replies`,
        'POST',
        input,
        decodeReplyReceipt
      );
    },
    edit({ entryId, ...input }) {
      return boardRequest(
        `/api/v1/local/board/entries/${encodeURIComponent(entryId)}`,
        'PUT',
        input,
        decodeEditReceipt
      );
    },
    delete({ entryId, ...input }) {
      return boardRequest(
        `/api/v1/local/board/entries/${encodeURIComponent(entryId)}`,
        'DELETE',
        input,
        decodeDeleteReceipt
      );
    },
  };
  const profiles: ProfilePort = {
    async list() {
      const { response, value } = await jsonRequest('/api/v1/local/profiles');
      if (!response.ok) throw new LocalHttpError(response.status);
      if (!Array.isArray(value)) throw new Error('Invalid local profile projection.');
      return value.map(decodeProfileProjection);
    },
    async show(identityId) {
      const { response, value } = await jsonRequest(
        `/api/v1/local/profiles/${encodeURIComponent(identityId)}`
      );
      return checked(response, value, decodeProfileSnapshot);
    },
    async apply(identityId: string, expectedRevision: number, profile: Profile) {
      const { response, value } = await jsonRequest(
        `/api/v1/local/profiles/${encodeURIComponent(identityId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ expectedRevision, profile }),
        }
      );
      if (response.status === 409) throw new ProfileConflict();
      return checked(response, value, decodeProfileMutation);
    },
  };
  return {
    blocks,
    board,
    profiles,
    async preview(previewId) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(previewId)) throw new Error('Invalid prop preview ID.');
      const { response, value } = await jsonRequest(
        `/api/v1/local/prop-previews/${encodeURIComponent(previewId)}`
      );
      return checked(response, value, (candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
          throw new Error('Invalid prop preview.');
        const record = candidate as Record<string, unknown>;
        if (
          Object.keys(record).sort().join(',') !== 'digest,pack' ||
          typeof record.digest !== 'string' ||
          !/^sha256:[0-9a-f]{64}$/.test(record.digest)
        )
          throw new Error('Invalid prop preview.');
        return { digest: record.digest, pack: decodePropPack(record.pack) };
      });
    },
    async list() {
      const { response, value } = await jsonRequest('/api/v1/local/blocks');
      if (!response.ok) throw new LocalHttpError(response.status);
      if (!Array.isArray(value)) throw new Error('Invalid local Office projection.');
      return value.map((item) => decode(item));
    },
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}
