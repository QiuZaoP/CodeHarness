import fs from 'node:fs';
import path from 'node:path';
import addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { AppError } from './errors.js';
import type { TaskEvent } from './types.js';

type JsonSchema = Record<string, unknown>;

function readSchema(fileName: string): JsonSchema {
  return JSON.parse(fs.readFileSync(path.resolve('schemas', fileName), 'utf8')) as JsonSchema;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
ajv.addSchema(readSchema('domain.schema.json'));
const validateTaskEvent = ajv.compile(readSchema('event.schema.json'));

export function assertTaskEventContract(event: TaskEvent): void {
  if (validateTaskEvent(event)) return;
  throw new AppError(
    'INTERNAL_ERROR',
    'Task event violates the public contract',
    { validationErrors: validateTaskEvent.errors },
    500
  );
}
