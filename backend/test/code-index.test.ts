import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db.js';
import { CodeIndexService } from '../src/code-index.js';

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
    expect(service.searchSemantic('project-1', 'helper value').mode).toBe('lexical');
  });
});
