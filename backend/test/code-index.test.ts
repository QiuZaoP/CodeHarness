import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db.js';
import { CodeIndexService } from '../src/code-index.js';
import { ToolExecutor } from '../src/tools.js';
import { WorkspaceManager } from '../src/workspace.js';

const databases: AppDatabase[] = [];

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('CodeIndexService', () => {
  it('indexes Python symbols, calls, dependencies, and searchable chunks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    await fs.writeFile(
      path.join(root, 'sample.py'),
      'import os\n\ndef run(value):\n    return os.path.join(value, helper())\n'
    );
    const database = new AppDatabase(path.join(root, 'index.sqlite'));
    databases.push(database);
    const service = new CodeIndexService(database);

    await service.build('project-1', root);

    expect(service.searchSymbols('project-1', 'run')).toMatchObject([
      { path: 'sample.py', name: 'run', kind: 'function', line: 3 }
    ]);
    expect(service.findCallers('project-1', 'helper')).toMatchObject([
      { path: 'sample.py', caller: 'run', callee: 'helper', line: 4 }
    ]);
    expect((await service.searchSemantic('project-1', 'helper value')).mode).toBe('lexical');
    expect(service.findReferences('project-1', 'helper')).toMatchObject([
      { path: 'sample.py', name: 'helper', line: 4 }
    ]);
    expect(service.findCallees('project-1', 'run')).toContainEqual(
      expect.objectContaining({ path: 'sample.py', caller: 'run', callee: 'helper', line: 4 })
    );
    expect(service.searchFiles('project-1', 'sample')).toMatchObject([
      { path: 'sample.py', language: 'Python' }
    ]);
  });

  it('uses stored embedding vectors to rank semantic queries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    await fs.writeFile(
      path.join(root, 'sample.py'),
      'def cache_lookup(key):\n    return key\n\ndef unrelated(value):\n    return value\n'
    );
    const database = new AppDatabase(path.join(root, 'index.sqlite'));
    databases.push(database);
    const service = new CodeIndexService(database, {
      embed: async (texts) =>
        texts.map((text) =>
          text.includes('cache_lookup') || text === 'retrieve cache entry' ? [1, 0] : [0, 1]
        )
    });

    await service.build('project-1', root);

    await expect(service.searchSemantic('project-1', 'retrieve cache entry')).resolves.toEqual({
      mode: 'vector',
      items: [
        expect.objectContaining({
          path: 'sample.py',
          line: 1,
          endLine: 2,
          entityType: 'code_chunk',
          summary: 'function cache_lookup'
        }),
        expect.objectContaining({ path: 'sample.py', line: 4, summary: 'function unrelated' })
      ]
    });
    expect(
      database.connection
        .prepare('SELECT vector_dimension FROM code_chunks WHERE project_id = ? ORDER BY line')
        .all('project-1')
    ).toEqual([{ vector_dimension: 2 }, { vector_dimension: 2 }]);
  });

  it('extracts definitions, calls, and imports from every supported AST language', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    await Promise.all([
      fs.writeFile(
        path.join(root, 'javascript.js'),
        "import helper from './helper.js';\nexport function javascriptRun() { return helper(); }\n"
      ),
      fs.writeFile(
        path.join(root, 'typescript.ts'),
        "import { helper } from './helper';\nexport function typescriptRun() { return helper(); }\n"
      ),
      fs.writeFile(
        path.join(root, 'component.tsx'),
        "import { helper } from './helper';\nexport function render() { return <div>{helper()}</div>; }\n"
      ),
      fs.writeFile(
        path.join(root, 'python.py'),
        'from helper import helper\ndef python_run():\n    return helper()\n'
      ),
      fs.writeFile(
        path.join(root, 'JavaRun.java'),
        'import helper.Helper; class JavaRun { void run() { helper(); } }\n'
      ),
      fs.writeFile(
        path.join(root, 'go_run.go'),
        'package sample\nimport "helper"\nfunc goRun() { helper() }\n'
      )
    ]);
    const database = new AppDatabase(path.join(root, 'index.sqlite'));
    databases.push(database);
    const service = new CodeIndexService(database);

    await service.build('project-1', root);

    for (const name of [
      'javascriptRun',
      'typescriptRun',
      'render',
      'python_run',
      'JavaRun',
      'run',
      'goRun'
    ]) {
      expect(service.searchSymbols('project-1', name)).not.toHaveLength(0);
    }
    expect(service.findCallers('project-1', 'helper')).toHaveLength(6);
    expect(
      database.connection
        .prepare('SELECT message FROM code_index_issues WHERE project_id = ? AND path = ?')
        .all('project-1', 'component.tsx')
    ).toEqual([]);
  });

  it('stores qualified class members and resolves their full or final symbol names', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    await fs.writeFile(
      path.join(root, 'service.py'),
      'class Service:\n    def execute(self):\n        return helper()\n'
    );
    const database = new AppDatabase(path.join(root, 'index.sqlite'));
    databases.push(database);
    const service = new CodeIndexService(database);

    await service.build('project-1', root);

    expect(service.searchSymbols('project-1', 'Service.execute')).toContainEqual(
      expect.objectContaining({ name: 'execute', qualifiedName: 'Service.execute' })
    );
    expect(service.findCallees('project-1', 'Service.execute')).toContainEqual(
      expect.objectContaining({ caller: 'Service.execute', callee: 'helper' })
    );
    expect(service.findCallees('project-1', 'execute')).toContainEqual(
      expect.objectContaining({ caller: 'Service.execute', callee: 'helper' })
    );
  });

  it('indexes TypeScript and TSX arrow-function declarations as functions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    await fs.writeFile(
      path.join(root, 'component.tsx'),
      'const renderPanel = () => <section>{helper()}</section>;\n'
    );
    const database = new AppDatabase(path.join(root, 'index.sqlite'));
    databases.push(database);
    const service = new CodeIndexService(database);

    await service.build('project-1', root);

    expect(service.searchSymbols('project-1', 'renderPanel')).toContainEqual(
      expect.objectContaining({ name: 'renderPanel', kind: 'function', line: 1 })
    );
    expect(service.findCallers('project-1', 'helper')).toContainEqual(
      expect.objectContaining({ caller: 'renderPanel', callee: 'helper', line: 1 })
    );
  });

  it('stores AST import targets and rebuilds only changed or deleted paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    const source = path.join(root, 'sample.js');
    await fs.writeFile(
      source,
      "import helper from './helper.js';\nexport function first() { return helper(); }\n"
    );
    const database = new AppDatabase(path.join(root, 'index.sqlite'));
    databases.push(database);
    const service = new CodeIndexService(database);

    await service.build('project-1', root);
    expect(
      database.connection
        .prepare('SELECT target FROM code_dependencies WHERE project_id = ? AND path = ?')
        .all('project-1', 'sample.js')
    ).toEqual([{ target: './helper.js' }]);

    await fs.writeFile(source, 'export function second() { return 2; }\n');
    await service.build('project-1', root);
    expect(service.searchSymbols('project-1', 'first')).toEqual([]);
    expect(service.searchSymbols('project-1', 'second')).toHaveLength(1);

    await fs.rm(source);
    await service.build('project-1', root);
    expect(service.searchFiles('project-1', 'sample')).toEqual([]);
    const indexNames = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_code_%'")
      .all() as Array<{ name: string }>;
    expect(indexNames.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'idx_code_files_project_path',
        'idx_code_symbols_name',
        'idx_code_references_name',
        'idx_code_calls_callee',
        'idx_code_dependencies_target'
      ])
    );
  });

  it('records parse failures while retaining a searchable file record', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    await fs.writeFile(path.join(root, 'broken.py'), 'def incomplete(:\n');
    const database = new AppDatabase(path.join(root, 'index.sqlite'));
    databases.push(database);
    const service = new CodeIndexService(database);

    await service.build('project-1', root);

    expect(service.searchFiles('project-1', 'broken')).toMatchObject([
      { path: 'broken.py', language: 'Python' }
    ]);
    expect(
      database.connection
        .prepare('SELECT message FROM code_index_issues WHERE project_id = ? AND path = ?')
        .all('project-1', 'broken.py')
    ).not.toEqual([]);
  });

  it('records parser loading failures while retaining a file-level fallback chunk', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    await fs.writeFile(path.join(root, 'fallback.py'), 'value = 1\n');
    const database = new AppDatabase(path.join(root, 'index.sqlite'));
    databases.push(database);
    const service = new CodeIndexService(database, undefined, () => {
      throw new Error('native grammar unavailable');
    });

    await service.build('project-1', root);

    expect(
      database.connection
        .prepare('SELECT message FROM code_index_issues WHERE project_id = ? AND path = ?')
        .all('project-1', 'fallback.py')
    ).toEqual([{ message: 'Parser unavailable: native grammar unavailable' }]);
    expect(
      database.connection
        .prepare('SELECT summary FROM code_chunks WHERE project_id = ? AND path = ?')
        .all('project-1', 'fallback.py')
    ).toEqual([{ summary: 'file fallback.py' }]);
  });

  it('creates a file-level chunk when a source file has no declarations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    await fs.writeFile(path.join(root, 'constants.py'), 'MAX_RETRIES = 3\n');
    const database = new AppDatabase(path.join(root, 'index.sqlite'));
    databases.push(database);
    const service = new CodeIndexService(database);

    await service.build('project-1', root);

    await expect(service.searchSemantic('project-1', 'max_retries')).resolves.toMatchObject({
      mode: 'lexical',
      items: [
        {
          path: 'constants.py',
          line: 1,
          endLine: 1,
          entityType: 'code_chunk',
          summary: 'file constants.py'
        }
      ]
    });
  });

  it('exposes every repository query through the Harness tool executor', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    await fs.writeFile(path.join(root, 'sample.py'), 'def run():\n    return helper()\n');
    const database = new AppDatabase(path.join(root, 'index.sqlite'));
    databases.push(database);
    const service = new CodeIndexService(database);
    const tools = new ToolExecutor(new WorkspaceManager(), service);

    await tools.indexRepository('project-1', root);

    expect(tools.searchFiles('project-1', 'sample')).toMatchObject([
      { path: 'sample.py', language: 'Python' }
    ]);
    expect(tools.searchSymbols('project-1', 'run')).toHaveLength(1);
    expect(tools.findReferences('project-1', 'helper')).toHaveLength(1);
    expect(tools.findCallers('project-1', 'helper')).toHaveLength(1);
    expect(tools.findCallees('project-1', 'run')).toHaveLength(1);
    expect((await tools.searchSemantic('project-1', 'helper')).mode).toBe('lexical');
    expect(tools.searchSymbols('project-1', 'run')[0]).toMatchObject({
      path: 'sample.py',
      line: 1,
      entityType: 'function',
      summary: 'function run'
    });
    expect(tools.findReferences('project-1', 'helper')[0]).toMatchObject({
      path: 'sample.py',
      line: 2,
      entityType: 'reference',
      summary: 'reference helper'
    });
  });

  it('declares all index tools in the versioned schemas and API contract', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
    const requiredTools = [
      'index_repository',
      'search_files',
      'search_symbols',
      'find_references',
      'find_callers',
      'find_callees',
      'search_semantic'
    ];
    const domain = JSON.parse(
      await fs.readFile(path.join(repositoryRoot, 'schemas', 'domain.schema.json'), 'utf8')
    );
    const openApi = JSON.parse(
      await fs.readFile(path.join(repositoryRoot, 'schemas', 'openapi.json'), 'utf8')
    );
    const contract = await fs.readFile(
      path.join(repositoryRoot, 'docs', 'API_CONTRACT.md'),
      'utf8'
    );

    expect(domain.$defs.toolCall.properties.name.enum).toEqual(
      expect.arrayContaining(requiredTools)
    );
    expect(openApi.components.schemas.ToolCall.properties.name.enum).toEqual(
      expect.arrayContaining(requiredTools)
    );
    expect(domain.$defs.toolCall.allOf).toHaveLength(requiredTools.length);
    expect(openApi.components.schemas.ToolCall.allOf).toHaveLength(requiredTools.length);
    expect(domain.$defs.indexQueryResult.required).toEqual(
      expect.arrayContaining(['path', 'line', 'entityType', 'summary'])
    );
    expect(openApi.components.schemas.SemanticSearchResult.properties.mode.enum).toEqual([
      'vector',
      'lexical'
    ]);
    expect(contract).toContain('search_semantic');
    expect(contract).toContain('lexical');
  });
});
