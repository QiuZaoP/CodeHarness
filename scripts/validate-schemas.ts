import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const root = path.resolve('schemas');
const status = JSON.parse(fs.readFileSync(path.join(root, 'task-status.schema.json'), 'utf8'));
const event = JSON.parse(fs.readFileSync(path.join(root, 'event.schema.json'), 'utf8'));
const domain = JSON.parse(fs.readFileSync(path.join(root, 'domain.schema.json'), 'utf8'));
const openapi = JSON.parse(fs.readFileSync(path.join(root, 'openapi.json'), 'utf8'));
const ajv = new Ajv2020({ strict: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
ajv.addSchema(status);
ajv.compile(event);
ajv.compile(domain);
if (openapi.openapi !== '3.1.0' || !openapi.paths || !openapi.components) {
  throw new Error('OpenAPI document is missing required fields');
}
console.log('Schema validation passed');
