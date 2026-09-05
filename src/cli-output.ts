import { createUI } from './ui.js';
import type { UI } from './types.js';

export interface CliOutput {
  readonly ui: UI;
  readonly hasJson: () => boolean;
  readonly hasError: () => boolean;
  readonly hasDuplicateJson: () => boolean;
  readonly setJson: (data: unknown) => void;
  readonly replaceJson: (data: unknown) => void;
  /** Replace a pending result without losing bounded request inspection fields. */
  readonly replaceFailure: (error: { code: string; message: string }) => void;
  readonly flush: () => void;
}

export class CliOutputSerializationError extends Error {
  constructor(cause: unknown) {
    super('Could not serialize JSON output.', { cause });
    this.name = 'CliOutputSerializationError';
  }
}

function requestCorrelation(document: unknown): Record<string, string> {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return {};
  // Read data properties only: failure reporting must not evaluate arbitrary getters.
  const field = (key: string): unknown => Object.getOwnPropertyDescriptor(document, key)?.value;
  const requestId = field('requestId');
  if (typeof requestId !== 'string' || requestId.length === 0 || Buffer.byteLength(requestId) > 256)
    return {};
  const correlation: Record<string, string> = { requestId };
  const target = field('target');
  const pane = field('pane');
  if (typeof target === 'string' && target.length > 0 && Buffer.byteLength(target) <= 256)
    correlation.target = target;
  if (typeof pane === 'string' && pane.length <= 256 && /^%\d+$/.test(pane))
    correlation.pane = pane;
  return correlation;
}

/**
 * Own process-boundary output so JSON is emitted once, after resource cleanup.
 * Human output remains streamed through the established UI implementation.
 */
export function createCliOutput(jsonMode: boolean): CliOutput {
  let jsonDocument: unknown;
  let hasJson = false;
  let duplicateJson = false;
  let flushed = false;

  const setJson = (data: unknown): void => {
    if (hasJson) {
      duplicateJson = true;
      return;
    }
    jsonDocument = data;
    hasJson = true;
  };

  const hasError = (): boolean => {
    if (!jsonDocument || typeof jsonDocument !== 'object') return false;
    return 'error' in jsonDocument;
  };

  return {
    ui: createUI(jsonMode, { jsonSink: setJson }),
    hasJson: () => hasJson,
    hasError,
    hasDuplicateJson: () => duplicateJson,
    setJson,
    replaceJson: (data: unknown) => {
      jsonDocument = data;
      hasJson = true;
    },
    replaceFailure: (error) => {
      jsonDocument = { ...requestCorrelation(jsonDocument), error };
      hasJson = true;
    },
    flush: () => {
      if (!jsonMode || !hasJson || flushed) return;
      // Do not use process.exit: large JSON documents must be allowed to drain.
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(jsonDocument, null, 2);
      } catch (error) {
        throw new CliOutputSerializationError(error);
      }
      if (serialized === undefined) throw new CliOutputSerializationError('undefined result');
      process.stdout.write(`${serialized}\n`);
      flushed = true;
    },
  };
}
