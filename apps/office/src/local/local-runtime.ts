import { createContext } from 'react';
import { BlockConflict, validLayout } from '../blocks/block-contract.js';
import type { Block, BlockPort, Furniture } from '../blocks/block-contract.js';

export interface LocalBlockProjection {
  exists: true;
  blockId: string;
  identityId: string;
  identityName: string;
  revision: number;
  objects: Furniture[];
  updatedAtMs: number;
}

export interface LocalRuntime {
  blocks: BlockPort;
  list(): Promise<LocalBlockProjection[]>;
  dispose(): void;
}

export const LocalRuntimeContext = createContext<LocalRuntime | undefined>(undefined);

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`Local Office request failed (${status}).`);
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
  function decode(value: unknown): LocalBlockProjection {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid block.');
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !==
      'blockId,exists,identityId,identityName,objects,revision,updatedAtMs'
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
      !validLayout(block.objects)
    )
      throw new Error('Invalid block.');
    return block;
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
          if (!response.ok) throw new HttpError(response.status);
          const block = decode(value);
          if (!active || disposed) return;
          changed({
            revision: block.revision,
            objects: block.objects,
            updatedAtMs: block.updatedAtMs,
          });
          delay = 2_000;
        } catch (error) {
          if (!active || disposed) return;
          if (error instanceof HttpError && [401, 403, 404, 421].includes(error.status)) {
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
          body: JSON.stringify({ expectedRevision: revision, objects }),
        }
      );
      if (response.status === 409) throw new BlockConflict();
      if (!response.ok) throw new Error(`Local Office save failed (${response.status}).`);
      const block = decode(value);
      return { revision: block.revision, objects: block.objects, updatedAtMs: block.updatedAtMs };
    },
  };
  return {
    blocks,
    async list() {
      const { response, value } = await jsonRequest('/api/v1/local/blocks');
      if (!response.ok) throw new HttpError(response.status);
      if (!Array.isArray(value)) throw new Error('Invalid local Office projection.');
      return value.map(decode);
    },
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}
