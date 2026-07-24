import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
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

export interface TextCodeIndexOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxResults?: number;
}

const ignoredDirectories = new Set([
  '.git',
  '.data',
  '.next',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'venv'
]);

const languageByExtension: Record<string, string> = {
  '.c': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.css': 'CSS',
  '.go': 'Go',
  '.html': 'HTML',
  '.java': 'Java',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.json': 'JSON',
  '.kt': 'Kotlin',
  '.md': 'Markdown',
  '.php': 'PHP',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.rs': 'Rust',
  '.sh': 'Shell',
  '.sql': 'SQL',
  '.swift': 'Swift',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.vue': 'Vue',
  '.yaml': 'YAML',
  '.yml': 'YAML'
};

export class TextCodeIndex implements CodeIndex {
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxResults: number;

  constructor(
    private readonly resolveProjectPath: (projectId: string) => string | undefined,
    options: TextCodeIndexOptions = {}
  ) {
    this.maxFiles = options.maxFiles ?? 20_000;
    this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    this.maxResults = options.maxResults ?? 200;
  }

  async getProjectOverview(projectId: string, signal: AbortSignal): Promise<ProjectOverview> {
    const files = await this.scan(projectId, signal);
    const languages = new Set<string>();
    const entryFiles: string[] = [];
    const testFiles: string[] = [];
    for (const file of files) {
      const language = languageByExtension[path.extname(file).toLowerCase()];
      if (language) languages.add(language);
      const base = path.basename(file).toLowerCase();
      if (/^(index|main|app|server)\.[^.]+$/.test(base)) entryFiles.push(file);
      if (/(^|[./\\])(__tests__|test|tests)([./\\]|$)|\.(spec|test)\./i.test(file)) {
        testFiles.push(file);
      }
    }
    return {
      projectId,
      languages: [...languages].sort(),
      entryFiles: entryFiles.slice(0, this.maxResults),
      testFiles: testFiles.slice(0, this.maxResults),
      buildCommands: await this.detectBuildCommands(projectId, files, signal),
      indexedFiles: files.length,
      degraded: true
    };
  }

  async searchFiles(
    projectId: string,
    query: string,
    signal: AbortSignal
  ): Promise<FileSearchResult[]> {
    const normalized = query.toLocaleLowerCase();
    return (await this.scan(projectId, signal))
      .filter((file) => file.toLocaleLowerCase().includes(normalized))
      .slice(0, this.maxResults)
      .map((file) => ({
        path: file,
        language: languageByExtension[path.extname(file).toLowerCase()]
      }));
  }

  async searchText(
    projectId: string,
    query: string,
    signal: AbortSignal
  ): Promise<TextSearchResult[]> {
    const root = await this.projectRoot(projectId);
    const results: TextSearchResult[] = [];
    for (const relative of await this.scan(projectId, signal)) {
      this.throwIfAborted(signal);
      const absolute = path.join(root, ...relative.split('/'));
      let buffer: Buffer;
      try {
        const stat = await fs.lstat(absolute);
        if (!stat.isFile() || stat.size > this.maxFileBytes) continue;
        buffer = await fs.readFile(absolute, { signal });
      } catch {
        if (signal.aborted) throw signal.reason;
        continue;
      }
      if (buffer.subarray(0, 8_000).includes(0)) continue;
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        continue;
      }
      for (const [index, line] of content.split(/\r\n|\r|\n/).entries()) {
        const column = line.indexOf(query);
        if (column === -1) continue;
        results.push({
          path: relative,
          line: index + 1,
          column: column + 1,
          preview: line.slice(0, 2_000)
        });
        if (results.length >= this.maxResults) return results;
      }
    }
    return results;
  }

  async searchSymbols(
    projectId: string,
    _query: string,
    signal: AbortSignal
  ): Promise<SymbolSearchResult[]> {
    await this.projectRoot(projectId);
    this.throwIfAborted(signal);
    return [];
  }

  async findReferences(
    projectId: string,
    _symbol: string,
    signal: AbortSignal
  ): Promise<ReferenceResult[]> {
    await this.projectRoot(projectId);
    this.throwIfAborted(signal);
    return [];
  }

  async findCallHierarchy(
    projectId: string,
    _symbol: string,
    _maxDepth: number,
    signal: AbortSignal
  ): Promise<CallHierarchyResult[]> {
    await this.projectRoot(projectId);
    this.throwIfAborted(signal);
    return [];
  }

  async searchSemantic(
    projectId: string,
    _query: string,
    _limit: number,
    signal: AbortSignal
  ): Promise<SemanticSearchResult[]> {
    await this.projectRoot(projectId);
    this.throwIfAborted(signal);
    return [];
  }

  private async scan(projectId: string, signal: AbortSignal): Promise<string[]> {
    const root = await this.projectRoot(projectId);
    const files: string[] = [];
    const walk = async (relativeDirectory: string): Promise<void> => {
      this.throwIfAborted(signal);
      const directory = path.join(root, ...relativeDirectory.split('/').filter(Boolean));
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        this.throwIfAborted(signal);
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) await walk(relative);
          continue;
        }
        if (!entry.isFile()) continue;
        files.push(relative);
        if (files.length > this.maxFiles) {
          throw new AppError(
            'INDEX_ERROR',
            'Project exceeds the text index file limit',
            { category: 'LIMIT', maxFiles: this.maxFiles },
            413
          );
        }
      }
    };
    try {
      await walk('');
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof AppError) throw error;
      throw new AppError(
        'INDEX_ERROR',
        'Text index scan failed',
        {
          category: 'UNAVAILABLE',
          projectId,
          cause: error instanceof Error ? error.message : String(error)
        },
        503
      );
    }
    return files;
  }

  private async detectBuildCommands(
    projectId: string,
    files: readonly string[],
    signal: AbortSignal
  ): Promise<string[]> {
    if (!files.includes('package.json')) return [];
    this.throwIfAborted(signal);
    const root = await this.projectRoot(projectId);
    try {
      const packagePath = path.join(root, 'package.json');
      const stat = await fs.lstat(packagePath);
      if (!stat.isFile() || stat.size > this.maxFileBytes) return [];
      const raw = await fs.readFile(packagePath, { encoding: 'utf8', signal });
      const scripts = (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts ?? {};
      return ['test', 'build', 'check']
        .filter((script) => typeof scripts[script] === 'string')
        .map((script) => (script === 'test' ? 'npm test' : `npm run ${script}`));
    } catch {
      if (signal.aborted) throw signal.reason;
      return [];
    }
  }

  private async projectRoot(projectId: string): Promise<string> {
    const resolved = this.resolveProjectPath(projectId);
    if (!resolved) {
      throw new AppError('INDEX_ERROR', 'Project is unavailable to the code index', {
        category: 'NOT_FOUND',
        projectId
      });
    }
    const root = await fs.realpath(resolved).catch(() => undefined);
    const stat = root ? await fs.lstat(root).catch(() => undefined) : undefined;
    if (!root || !stat?.isDirectory()) {
      throw new AppError('INDEX_ERROR', 'Project source directory is unavailable', {
        category: 'UNAVAILABLE',
        projectId
      });
    }
    return root;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
  }
}
