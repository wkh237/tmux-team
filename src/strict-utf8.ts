import { TextDecoder } from 'node:util';

/** Decode bytes as well-formed UTF-8 without normalizing the decoded text. */
export function decodeStrictUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
