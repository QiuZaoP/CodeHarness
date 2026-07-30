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

export interface FakeCodeIndexData {
  overview: ProjectOverview;
  files?: FileSearchResult[];
  text?: TextSearchResult[];
  symbols?: SymbolSearchResult[];
  references?: ReferenceResult[];
  callHierarchy?: CallHierarchyResult[];
  semantic?: SemanticSearchResult[];
}

export class FakeCodeIndex implements CodeIndex {
  constructor(private readonly data: FakeCodeIndexData) {}

  async getProjectOverview(_projectId: string, signal: AbortSignal): Promise<ProjectOverview> {
    signal.throwIfAborted();
    return this.data.overview;
  }

  async searchFiles(
    _projectId: string,
    query: string,
    signal: AbortSignal
  ): Promise<FileSearchResult[]> {
    signal.throwIfAborted();
    return (this.data.files ?? []).filter((result) => result.path.includes(query));
  }

  async searchText(
    _projectId: string,
    query: string,
    signal: AbortSignal
  ): Promise<TextSearchResult[]> {
    signal.throwIfAborted();
    return (this.data.text ?? []).filter((result) => result.preview.includes(query));
  }

  async searchSymbols(
    _projectId: string,
    query: string,
    signal: AbortSignal
  ): Promise<SymbolSearchResult[]> {
    signal.throwIfAborted();
    return (this.data.symbols ?? []).filter((result) => result.name.includes(query));
  }

  async findReferences(
    _projectId: string,
    symbol: string,
    signal: AbortSignal
  ): Promise<ReferenceResult[]> {
    signal.throwIfAborted();
    return (this.data.references ?? []).filter((result) => result.symbol === symbol);
  }

  async findCallHierarchy(
    _projectId: string,
    symbol: string,
    maxDepth: number,
    signal: AbortSignal
  ): Promise<CallHierarchyResult[]> {
    signal.throwIfAborted();
    return (this.data.callHierarchy ?? []).filter(
      (result) => result.symbol === symbol && result.depth <= maxDepth
    );
  }

  async searchSemantic(
    _projectId: string,
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<SemanticSearchResult[]> {
    signal.throwIfAborted();
    return (this.data.semantic ?? [])
      .filter((result) => result.preview.includes(query))
      .slice(0, limit);
  }
}
