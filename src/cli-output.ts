import { createUI } from './ui.js';
import type { UI } from './types.js';

export interface CliOutput {
  readonly ui: UI;
  readonly hasJson: () => boolean;
  readonly hasError: () => boolean;
  readonly hasDuplicateJson: () => boolean;
  readonly setJson: (data: unknown) => void;
  readonly replaceJson: (data: unknown) => void;
  readonly flush: () => void;
}

export class CliOutputSerializationError extends Error {
  constructor(cause: unknown) {
    super('Could not serialize JSON output.', { cause });
    this.name = 'CliOutputSerializationError';
  }
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
