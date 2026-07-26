import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppDatabase } from './db.js';

type SymbolResult = { path: string; name: string; kind: string; line: number };
type CallResult = { path: string; caller: string | null; callee: string; line: number };
type SemanticResult = {
  mode: 'vector' | 'lexical';
  items: Array<{ path: string; line: number; summary: string }>;
};

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.data', '__pycache__']);
const languageByExtension: Record<string, string> = {
  '.py': 'Python',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.java': 'Java',
  '.go': 'Go'
};

export class CodeIndexService {
  constructor(
    private readonly database: AppDatabase,
    private readonly embeddings?: EmbeddingProvider
  ) {
    this.database.connection.exec(`
      CREATE TABLE IF NOT EXISTS code_files (project_id TEXT NOT NULL, path TEXT NOT NULL, language TEXT, hash TEXT NOT NULL, content TEXT, PRIMARY KEY(project_id, path));
      CREATE TABLE IF NOT EXISTS code_symbols (project_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS code_calls (project_id TEXT NOT NULL, path TEXT NOT NULL, caller TEXT, callee TEXT NOT NULL, line INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS code_dependencies (project_id TEXT NOT NULL, path TEXT NOT NULL, target TEXT NOT NULL, line INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS code_chunks (project_id TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL, vector_json TEXT);
      CREATE TABLE IF NOT EXISTS code_index_issues (project_id TEXT NOT NULL, path TEXT NOT NULL, message TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(project_id, name);
      CREATE INDEX IF NOT EXISTS idx_code_calls_callee ON code_calls(project_id, callee);
    `);
  }

  async build(projectId: string, root: string): Promise<void> {
    const files = await this.scan(root);
    const current = new Map(
      this.database.connection
        .prepare('SELECT path, hash FROM code_files WHERE project_id = ?')
        .all(projectId)
        .map((row: any) => [row.path, row.hash])
    );
    const active = new Set(files.map((file) => file.path));
    const transaction = this.database.connection.transaction((entries: IndexedFile[]) => {
      for (const oldPath of current.keys())
        if (!active.has(oldPath)) this.removePath(projectId, oldPath);
      for (const file of entries) {
        if (current.get(file.path) === file.hash) continue;
        this.removePath(projectId, file.path);
        this.database.connection
          .prepare(
            'INSERT INTO code_files(project_id,path,language,hash,content) VALUES(?,?,?,?,?)'
          )
          .run(projectId, file.path, file.language, file.hash, file.content);
        const parsed = parse(file);
        const insertSymbol = this.database.connection.prepare(
          'INSERT INTO code_symbols VALUES(?,?,?,?,?)'
        );
        const insertCall = this.database.connection.prepare(
          'INSERT INTO code_calls VALUES(?,?,?,?,?)'
        );
        const insertDependency = this.database.connection.prepare(
          'INSERT INTO code_dependencies VALUES(?,?,?,?)'
        );
        const insertChunk = this.database.connection.prepare(
          'INSERT INTO code_chunks VALUES(?,?,?,?,?,NULL)'
        );
        for (const symbol of parsed.symbols) {
          insertSymbol.run(projectId, file.path, symbol.name, symbol.kind, symbol.line);
          insertChunk.run(
            projectId,
            file.path,
            symbol.line,
            `${symbol.kind} ${symbol.name}`,
            symbol.content
          );
        }
        for (const call of parsed.calls)
          insertCall.run(projectId, file.path, call.caller, call.callee, call.line);
        for (const dependency of parsed.dependencies)
          insertDependency.run(projectId, file.path, dependency.target, dependency.line);
        for (const issue of parsed.issues)
          this.database.connection
            .prepare('INSERT INTO code_index_issues VALUES(?,?,?)')
            .run(projectId, file.path, issue);
      }
    });
    transaction(files);
    if (this.embeddings) await this.populateVectors(projectId);
  }

  searchSymbols(projectId: string, query: string): SymbolResult[] {
    return this.database.connection
      .prepare(
        'SELECT path,name,kind,line FROM code_symbols WHERE project_id = ? AND lower(name) LIKE ? ORDER BY path,line'
      )
      .all(projectId, `%${query.toLowerCase()}%`) as SymbolResult[];
  }

  findCallers(projectId: string, callee: string): CallResult[] {
    return this.database.connection
      .prepare(
        'SELECT path,caller,callee,line FROM code_calls WHERE project_id = ? AND (lower(callee) = ? OR lower(callee) LIKE ?) ORDER BY path,line'
      )
      .all(projectId, callee.toLowerCase(), `%.${callee.toLowerCase()}`) as CallResult[];
  }

  searchSemantic(projectId: string, query: string): SemanticResult {
    const queryTerms = tokens(query);
    const chunks = this.database.connection
      .prepare(
        'SELECT path,line,summary,content,vector_json as vectorJson FROM code_chunks WHERE project_id = ?'
      )
      .all(projectId) as Array<{
      path: string;
      line: number;
      summary: string;
      content: string;
      vectorJson?: string;
    }>;
    const vector = chunks.some((chunk) => chunk.vectorJson) ? this.embeddings : undefined;
    const items = chunks
      .map((chunk) => ({
        path: chunk.path,
        line: chunk.line,
        summary: chunk.summary,
        score: overlap(queryTerms, tokens(`${chunk.summary} ${chunk.content}`))
      }))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 20)
      .map((chunk) => ({ path: chunk.path, line: chunk.line, summary: chunk.summary }));
    return { mode: vector ? 'vector' : 'lexical', items };
  }

  private removePath(projectId: string, filePath: string): void {
    for (const table of [
      'code_files',
      'code_symbols',
      'code_calls',
      'code_dependencies',
      'code_chunks',
      'code_index_issues'
    ])
      this.database.connection
        .prepare(`DELETE FROM ${table} WHERE project_id = ? AND path = ?`)
        .run(projectId, filePath);
  }

  private async scan(root: string): Promise<IndexedFile[]> {
    const result: IndexedFile[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) {
          const extension = path.extname(entry.name).toLowerCase();
          const language = languageByExtension[extension];
          if (!language) continue;
          const content = await fs.readFile(absolute, 'utf8').catch(() => undefined);
          if (content === undefined) continue;
          result.push({
            path: path.relative(root, absolute).split(path.sep).join('/'),
            language,
            content,
            hash: createHash('sha256').update(content).digest('hex')
          });
        }
      }
    };
    await walk(root);
    return result;
  }

  private async populateVectors(projectId: string): Promise<void> {
    if (!this.embeddings) return;
    const chunks = this.database.connection
      .prepare(
        'SELECT rowid, summary, content FROM code_chunks WHERE project_id = ? AND vector_json IS NULL'
      )
      .all(projectId) as Array<{ rowid: number; summary: string; content: string }>;
    const vectors = await this.embeddings.embed(
      chunks.map((chunk) => `${chunk.summary}\n${chunk.content}`)
    );
    const update = this.database.connection.prepare(
      'UPDATE code_chunks SET vector_json = ? WHERE rowid = ?'
    );
    chunks.forEach((chunk, index) => update.run(JSON.stringify(vectors[index]), chunk.rowid));
  }
}

type IndexedFile = { path: string; language: string; content: string; hash: string };
function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
}
function overlap(left: Set<string>, right: Set<string>): number {
  return left.size && right.size
    ? [...left].filter((item) => right.has(item)).length / new Set([...left, ...right]).size
    : 0;
}
function line(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}
function parse(file: IndexedFile) {
  const symbols: Array<{ name: string; kind: string; line: number; content: string }> = [];
  const calls: Array<{ caller: string | null; callee: string; line: number }> = [];
  const dependencies: Array<{ target: string; line: number }> = [];
  const issues: string[] = [];
  if (file.language === 'Python' && !/\n/.test(file.content) && /def\s/.test(file.content))
    issues.push('Parse failed: incomplete Python source');
  const functionPattern =
    file.language === 'Python'
      ? /^\s*(?:async\s+)?def\s+(\w+)\s*\(/gm
      : /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|\bfunc\s+(\w+)\s*\(|\bclass\s+(\w+)/gm;
  for (const match of file.content.matchAll(functionPattern)) {
    const name = match[1] ?? match[2] ?? match[3];
    const offset = (match.index ?? 0) + match[0].search(/(?:def|function|func|class)\b/);
    const symbolLine = line(file.content, offset);
    symbols.push({
      name,
      kind: match[3] ? 'class' : 'function',
      line: symbolLine,
      content: file.content.split('\n')[symbolLine - 1] ?? ''
    });
  }
  for (const match of file.content.matchAll(
    /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+)|from\s+['"]([^'"]+)['"])/gm
  ))
    dependencies.push({
      target: match[1] ?? match[2] ?? match[3],
      line: line(file.content, match.index ?? 0)
    });
  for (const match of file.content.matchAll(/\b([A-Za-z_]\w*(?:\.\w+)*)\s*\(/g)) {
    const callee = match[1];
    if (!symbols.some((symbol) => symbol.name === callee))
      calls.push({
        caller:
          symbols.find((symbol) => symbol.line <= line(file.content, match.index ?? 0))?.name ??
          null,
        callee,
        line: line(file.content, match.index ?? 0)
      });
  }
  return { symbols, calls, dependencies, issues };
}
