import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import Go from 'tree-sitter-go';
import type { AppDatabase } from './db.js';

type SymbolResult = {
  path: string;
  name: string;
  kind: string;
  line: number;
  entityType: string;
  summary: string;
};
type CallResult = {
  path: string;
  caller: string | null;
  callee: string;
  line: number;
  entityType: 'call';
  summary: string;
};
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
  '.tsx': 'TSX',
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
      CREATE TABLE IF NOT EXISTS code_references (project_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, line INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS code_calls (project_id TEXT NOT NULL, path TEXT NOT NULL, caller TEXT, callee TEXT NOT NULL, line INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS code_dependencies (project_id TEXT NOT NULL, path TEXT NOT NULL, target TEXT NOT NULL, line INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS code_chunks (project_id TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL, vector_json TEXT);
      CREATE TABLE IF NOT EXISTS code_index_issues (project_id TEXT NOT NULL, path TEXT NOT NULL, message TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_code_files_project_path ON code_files(project_id, path);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(project_id, name);
      CREATE INDEX IF NOT EXISTS idx_code_references_name ON code_references(project_id, name);
      CREATE INDEX IF NOT EXISTS idx_code_calls_callee ON code_calls(project_id, callee);
      CREATE INDEX IF NOT EXISTS idx_code_dependencies_target ON code_dependencies(project_id, target);
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
        const insertReference = this.database.connection.prepare(
          'INSERT INTO code_references VALUES(?,?,?,?)'
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
        for (const reference of parsed.references)
          insertReference.run(projectId, file.path, reference.name, reference.line);
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
        "SELECT path,name,kind,line,kind AS entityType,kind || ' ' || name AS summary FROM code_symbols WHERE project_id = ? AND lower(name) LIKE ? ORDER BY path,line"
      )
      .all(projectId, `%${query.toLowerCase()}%`) as SymbolResult[];
  }

  findCallers(projectId: string, callee: string): CallResult[] {
    return this.database.connection
      .prepare(
        "SELECT path,caller,callee,line,'call' AS entityType,COALESCE(caller, '<file>') || ' -> ' || callee AS summary FROM code_calls WHERE project_id = ? AND (lower(callee) = ? OR lower(callee) LIKE ?) ORDER BY path,line"
      )
      .all(projectId, callee.toLowerCase(), `%.${callee.toLowerCase()}`) as CallResult[];
  }

  findReferences(
    projectId: string,
    name: string
  ): Array<{ path: string; name: string; line: number; entityType: 'reference'; summary: string }> {
    return this.database.connection
      .prepare(
        "SELECT path,name,line,'reference' AS entityType,'reference ' || name AS summary FROM code_references WHERE project_id = ? AND lower(name) = ? ORDER BY path,line"
      )
      .all(projectId, name.toLowerCase()) as Array<{
      path: string;
      name: string;
      line: number;
      entityType: 'reference';
      summary: string;
    }>;
  }

  findCallees(projectId: string, caller: string): CallResult[] {
    return this.database.connection
      .prepare(
        "SELECT path,caller,callee,line,'call' AS entityType,COALESCE(caller, '<file>') || ' -> ' || callee AS summary FROM code_calls WHERE project_id = ? AND lower(caller) = ? ORDER BY path,line"
      )
      .all(projectId, caller.toLowerCase()) as CallResult[];
  }

  searchFiles(
    projectId: string,
    query: string
  ): Array<{ path: string; language: string; line: number; entityType: 'file'; summary: string }> {
    return this.database.connection
      .prepare(
        "SELECT path,language,1 AS line,'file' AS entityType,language || ' file ' || path AS summary FROM code_files WHERE project_id = ? AND lower(path) LIKE ? ORDER BY path"
      )
      .all(projectId, `%${query.toLowerCase()}%`) as Array<{
      path: string;
      language: string;
      line: number;
      entityType: 'file';
      summary: string;
    }>;
  }

  async searchSemantic(projectId: string, query: string): Promise<SemanticResult> {
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
    if (this.embeddings && chunks.some((chunk) => chunk.vectorJson)) {
      const [queryVector] = await this.embeddings.embed([query]);
      if (isVector(queryVector)) {
        const items = chunks
          .flatMap((chunk) => {
            const vector = parseVector(chunk.vectorJson);
            if (!vector || vector.length !== queryVector.length) return [];
            return [
              {
                path: chunk.path,
                line: chunk.line,
                summary: chunk.summary,
                score: cosineSimilarity(queryVector, vector)
              }
            ];
          })
          .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
          .slice(0, 20)
          .map(({ path, line, summary }) => ({ path, line, summary }));
        if (items.length > 0) return { mode: 'vector', items };
      }
    }
    const queryTerms = tokens(query);
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
    return { mode: 'lexical', items };
  }

  private removePath(projectId: string, filePath: string): void {
    for (const table of [
      'code_files',
      'code_symbols',
      'code_references',
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
    if (chunks.length === 0) return;
    const vectors = await this.embeddings.embed(
      chunks.map((chunk) => `${chunk.summary}\n${chunk.content}`)
    );
    const update = this.database.connection.prepare(
      'UPDATE code_chunks SET vector_json = ? WHERE rowid = ?'
    );
    chunks.forEach((chunk, index) => {
      if (isVector(vectors[index])) update.run(JSON.stringify(vectors[index]), chunk.rowid);
    });
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
function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => Number.isFinite(item));
}
function parseVector(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isVector(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
function cosineSimilarity(left: number[], right: number[]): number {
  const denominator = Math.hypot(...left) * Math.hypot(...right);
  return denominator === 0
    ? 0
    : left.reduce((sum, item, index) => sum + item * right[index], 0) / denominator;
}
function isImportNode(type: string): boolean {
  return ['import_statement', 'import_from_statement', 'import_declaration'].includes(type);
}
function dependencyTarget(node: Parser.SyntaxNode): string | undefined {
  const source =
    node.childForFieldName('source') ??
    node.namedChildren.find((child) => child.type.includes('string'));
  const raw = (source?.text ?? node.text).trim();
  const quoted = raw.match(/['"]([^'"]+)['"]/);
  if (quoted) return quoted[1];
  const from = raw.match(/\bfrom\s+([\w.]+)/);
  if (from) return from[1];
  return raw.match(/^import\s+([\w.]+)/)?.[1];
}
function parse(file: IndexedFile) {
  const symbols: Array<{ name: string; kind: string; line: number; content: string }> = [];
  const calls: Array<{ caller: string | null; callee: string; line: number }> = [];
  const dependencies: Array<{ target: string; line: number }> = [];
  const references: Array<{ name: string; line: number }> = [];
  const issues: string[] = [];
  const parser = new Parser();
  parser.setLanguage(languageFor(file.language));
  const tree = parser.parse(file.content);
  const walk = (node: Parser.SyntaxNode, caller: string | null = null): void => {
    if (node.type === 'ERROR' || node.hasError)
      issues.push(`Parse error at line ${node.startPosition.row + 1}`);
    const text = node.text;
    const nodeLine = node.startPosition.row + 1;
    if (
      [
        'function_definition',
        'function_declaration',
        'method_definition',
        'method_declaration',
        'class_definition',
        'class_declaration'
      ].includes(node.type)
    ) {
      const name =
        node.childForFieldName('name')?.text ??
        node.namedChildren.find((child) => child.type.includes('identifier'))?.text;
      if (name) {
        const kind = node.type.includes('class')
          ? 'class'
          : node.type.includes('method')
            ? 'method'
            : 'function';
        symbols.push({ name, kind, line: nodeLine, content: text });
        caller = name;
      }
    }
    if (isImportNode(node.type)) {
      const target = dependencyTarget(node);
      if (target) dependencies.push({ target, line: nodeLine });
    }
    if (
      node.type === 'call' ||
      node.type === 'call_expression' ||
      node.type === 'method_invocation'
    )
      calls.push({
        caller,
        callee:
          node.childForFieldName('function')?.text ??
          node.namedChildren[0]?.text ??
          text.split('(')[0],
        line: nodeLine
      });
    if (node.type === 'identifier') references.push({ name: text, line: nodeLine });
    for (const child of node.namedChildren) walk(child, caller);
  };
  walk(tree.rootNode);
  return { symbols, calls, dependencies, references, issues: [...new Set(issues)] };
}
function languageFor(language: string): Parameters<Parser['setLanguage']>[0] {
  return (
    (
      {
        JavaScript,
        TypeScript: TypeScript.typescript,
        TSX: TypeScript.tsx,
        Python,
        Java,
        Go
      } as Record<string, Parameters<Parser['setLanguage']>[0]>
    )[language] ?? JavaScript
  );
}
