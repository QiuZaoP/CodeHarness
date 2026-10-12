import { AppError } from '../errors.js';
import type {
  CallHierarchyResult,
  CodeIndex,
  FileSearchResult,
  ProjectOverview,
  ReferenceResult,
  SemanticSearchResult,
  SymbolSearchResult,
  TextSearchResult
} from '../ports/code-index.js';

export class FallbackCodeIndex implements CodeIndex {
  constructor(
    private readonly primary: CodeIndex,
    private readonly fallback: CodeIndex
  ) {}

  getProjectOverview(projectId: string, signal: AbortSignal): Promise<ProjectOverview> {
    return this.withFallback(
      'getProjectOverview',
      signal,
      () => this.primary.getProjectOverview(projectId, signal),
      async () => ({
        ...(await this.fallback.getProjectOverview(projectId, signal)),
        degraded: true
      })
    );
  }

  searchFiles(projectId: string, query: string, signal: AbortSignal): Promise<FileSearchResult[]> {
    return this.withFallback(
      'searchFiles',
      signal,
      () => this.primary.searchFiles(projectId, query, signal),
      () => this.fallback.searchFiles(projectId, query, signal)
    );
  }

  searchText(projectId: string, query: string, signal: AbortSignal): Promise<TextSearchResult[]> {
    return this.withFallback(
      'searchText',
      signal,
      () => this.primary.searchText(projectId, query, signal),
      () => this.fallback.searchText(projectId, query, signal)
    );
  }

  searchSymbols(
    projectId: string,
    query: string,
    signal: AbortSignal
  ): Promise<SymbolSearchResult[]> {
    return this.withFallback(
      'searchSymbols',
      signal,
      () => this.primary.searchSymbols(projectId, query, signal),
      () => this.fallback.searchSymbols(projectId, query, signal)
    );
  }

  findReferences(
    projectId: string,
    symbol: string,
    signal: AbortSignal
  ): Promise<ReferenceResult[]> {
    return this.withFallback(
      'findReferences',
      signal,
      () => this.primary.findReferences(projectId, symbol, signal),
      () => this.fallback.findReferences(projectId, symbol, signal)
    );
  }

  findCallHierarchy(
    projectId: string,
    symbol: string,
    maxDepth: number,
    signal: AbortSignal
  ): Promise<CallHierarchyResult[]> {
    return this.withFallback(
      'findCallHierarchy',
      signal,
      () => this.primary.findCallHierarchy(projectId, symbol, maxDepth, signal),
      () => this.fallback.findCallHierarchy(projectId, symbol, maxDepth, signal)
    );
  }

  searchSemantic(
    projectId: string,
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<SemanticSearchResult[]> {
    return this.withFallback(
      'searchSemantic',
      signal,
      () => this.primary.searchSemantic(projectId, query, limit, signal),
      () => this.fallback.searchSemantic(projectId, query, limit, signal)
    );
  }

  private async withFallback<T>(
    operation: string,
    signal: AbortSignal,
    primary: () => Promise<T>,
    fallback: () => Promise<T>
  ): Promise<T> {
    try {
      return await primary();
    } catch (primaryError) {
      if (signal.aborted) throw signal.reason;
      try {
        return await fallback();
      } catch (fallbackError) {
        if (signal.aborted) throw signal.reason;
        throw new AppError(
          'INDEX_ERROR',
          `Code index ${operation} and its text fallback failed`,
          {
            category: 'UNAVAILABLE',
            primary: this.errorMessage(primaryError),
            fallback: this.errorMessage(fallbackError)
          },
          503
        );
      }
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
