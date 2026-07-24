export interface ProjectOverview {
  projectId: string;
  languages: string[];
  entryFiles: string[];
  testFiles: string[];
  buildCommands: string[];
  indexedFiles: number;
  degraded: boolean;
}

export interface FileSearchResult {
  path: string;
  language?: string;
  summary?: string;
}

export interface TextSearchResult {
  path: string;
  line: number;
  column?: number;
  preview: string;
}

export interface SymbolSearchResult {
  name: string;
  kind: string;
  path: string;
  line: number;
}

export interface ReferenceResult {
  symbol: string;
  path: string;
  line: number;
  relation: 'DEFINITION' | 'REFERENCE' | 'CALLER' | 'CALLEE';
}

export interface CallHierarchyResult {
  symbol: string;
  path: string;
  line: number;
  direction: 'CALLER' | 'CALLEE';
  depth: number;
}

export interface SemanticSearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  preview: string;
}

export interface CodeIndex {
  getProjectOverview(projectId: string, signal: AbortSignal): Promise<ProjectOverview>;
  searchFiles(projectId: string, query: string, signal: AbortSignal): Promise<FileSearchResult[]>;
  searchText(projectId: string, query: string, signal: AbortSignal): Promise<TextSearchResult[]>;
  searchSymbols(
    projectId: string,
    query: string,
    signal: AbortSignal
  ): Promise<SymbolSearchResult[]>;
  findReferences(
    projectId: string,
    symbol: string,
    signal: AbortSignal
  ): Promise<ReferenceResult[]>;
  findCallHierarchy(
    projectId: string,
    symbol: string,
    maxDepth: number,
    signal: AbortSignal
  ): Promise<CallHierarchyResult[]>;
  searchSemantic(
    projectId: string,
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<SemanticSearchResult[]>;
}
