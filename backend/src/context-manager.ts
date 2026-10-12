import { createHash } from 'node:crypto';
import type { ContextReference } from './types.js';

export interface ContextCandidate {
  reference: Omit<ContextReference, 'contentHash'>;
  content: string;
  priority: number;
}

export interface SelectedContext {
  reference: ContextReference;
  content: string;
}

export interface ContextSelection {
  entries: SelectedContext[];
  totalBytes: number;
  omittedEntries: number;
  truncatedEntries: number;
}

export interface ContextManagerOptions {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
}

export class ContextManager {
  constructor(private readonly options: ContextManagerOptions) {
    if (
      !Number.isInteger(options.maxEntries) ||
      options.maxEntries <= 0 ||
      !Number.isInteger(options.maxTotalBytes) ||
      options.maxTotalBytes <= 0 ||
      !Number.isInteger(options.maxEntryBytes) ||
      options.maxEntryBytes <= 0
    ) {
      throw new Error('Context limits must be positive integers');
    }
  }

  select(candidates: readonly ContextCandidate[]): ContextSelection {
    if (candidates.some(({ priority }) => !Number.isFinite(priority))) {
      throw new Error('Context priorities must be finite numbers');
    }
    const ordered = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.content.trim().length > 0)
      .sort(
        (left, right) =>
          right.candidate.priority - left.candidate.priority || left.index - right.index
      );
    const entries: SelectedContext[] = [];
    const refs = new Set<string>();
    const hashes = new Set<string>();
    let totalBytes = 0;
    let omittedEntries = 0;
    let truncatedEntries = 0;

    for (const { candidate } of ordered) {
      if (entries.length >= this.options.maxEntries || refs.has(candidate.reference.ref)) {
        omittedEntries += 1;
        continue;
      }
      const remaining = this.options.maxTotalBytes - totalBytes;
      if (remaining <= 0) {
        omittedEntries += 1;
        continue;
      }
      const limit = Math.min(this.options.maxEntryBytes, remaining);
      const content = truncateUtf8(candidate.content, limit);
      if (!content) {
        omittedEntries += 1;
        continue;
      }
      if (content !== candidate.content) truncatedEntries += 1;
      const contentHash = createHash('sha256').update(content).digest('hex');
      if (hashes.has(contentHash)) {
        omittedEntries += 1;
        continue;
      }
      const bytes = Buffer.byteLength(content);
      entries.push({
        reference: { ...candidate.reference, contentHash },
        content
      });
      refs.add(candidate.reference.ref);
      hashes.add(contentHash);
      totalBytes += bytes;
    }

    return { entries, totalBytes, omittedEntries, truncatedEntries };
  }
}

function truncateUtf8(content: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(content) <= maxBytes) return content;
  const suffix = '\n...[truncated]';
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes <= suffixBytes) {
    return shrinkToBytes(content, maxBytes);
  }
  return `${shrinkToBytes(content, maxBytes - suffixBytes)}${suffix}`;
}

function shrinkToBytes(content: string, maxBytes: number): string {
  let result = Buffer.from(content)
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD+$/u, '');
  while (Buffer.byteLength(result) > maxBytes) result = result.slice(0, -1);
  return result;
}
