import type { AppDatabase } from '../db.js';
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
import type { CodeIndexService } from '../code-index.js';

export class TreeSitterCodeIndex implements CodeIndex {
  constructor(
    private readonly database: AppDatabase,
    private readonly native: CodeIndexService,
    private readonly fallback: CodeIndex
  ) {}

  async getProjectOverview(projectId: string, signal: AbortSignal): Promise<ProjectOverview> {
    signal.throwIfAborted();
    const rows = this.database.connection
      .prepare('SELECT path, language FROM code_files WHERE project_id = ? ORDER BY path')
      .all(projectId) as Array<{ path: string; language: string }>;
    if (rows.length === 0) return this.fallback.getProjectOverview(projectId, signal);
    const languages = [...new Set(rows.map((row) => row.language))].sort();
    const entryFiles = rows
      .map((row) => row.path)
      .filter((filePath) => /(^|\/)(index|main|app|server)\.[^.]+$/i.test(filePath));
    const testFiles = rows
      .map((row) => row.path)
      .filter((filePath) =>
        /(^|[./\\])(__tests__|test|tests)([./\\]|$)|\.(spec|test)\./i.test(filePath)
      );
    return {
      projectId,
      languages,
      entryFiles,
      testFiles,
      buildCommands: [],
      indexedFiles: rows.length,
      degraded: false
    };
  }

  searchFiles(projectId: string, query: string, signal: AbortSignal): Promise<FileSearchResult[]> {
    signal.throwIfAborted();
    const results = this.native.searchFiles(projectId, query);
    return Promise.resolve(
      results.map(({ path, language, summary }) => ({ path, language, summary }))
    );
  }

  async searchText(
    projectId: string,
    query: string,
    signal: AbortSignal
  ): Promise<TextSearchResult[]> {
    return this.fallback.searchText(projectId, query, signal);
  }

  searchSymbols(
    projectId: string,
    query: string,
    signal: AbortSignal
  ): Promise<SymbolSearchResult[]> {
    signal.throwIfAborted();
    return Promise.resolve(
      this.native.searchSymbols(projectId, query).map(({ name, kind, path, line }) => ({
        name,
        kind,
        path,
        line
      }))
    );
  }

  findReferences(
    projectId: string,
    symbol: string,
    signal: AbortSignal
  ): Promise<ReferenceResult[]> {
    signal.throwIfAborted();
    return Promise.resolve(
      this.native.findReferences(projectId, symbol).map(({ name, path, line }) => ({
        symbol: name,
        path,
        line,
        relation: 'REFERENCE' as const
      }))
    );
  }

  findCallHierarchy(
    projectId: string,
    symbol: string,
    maxDepth: number,
    signal: AbortSignal
  ): Promise<CallHierarchyResult[]> {
    signal.throwIfAborted();
    if (maxDepth < 1) return Promise.resolve([]);
    const callers = this.native.findCallers(projectId, symbol).map((item) => ({
      symbol: item.caller ?? item.callee,
      path: item.path,
      line: item.line,
      direction: 'CALLER' as const,
      depth: 1
    }));
    const callees = this.native.findCallees(projectId, symbol).map((item) => ({
      symbol: item.callee,
      path: item.path,
      line: item.line,
      direction: 'CALLEE' as const,
      depth: 1
    }));
    return Promise.resolve([...callers, ...callees]);
  }

  async searchSemantic(
    projectId: string,
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<SemanticSearchResult[]> {
    signal.throwIfAborted();
    const result = await this.native.searchSemantic(projectId, query);
    return result.items.slice(0, limit).map((item) => ({
      path: item.path,
      startLine: item.line,
      endLine: item.endLine,
      score: 1,
      preview: item.summary
    }));
  }
}
