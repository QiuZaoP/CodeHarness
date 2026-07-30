import fs from 'node:fs';
import path from 'node:path';

type JsonSchema = Record<string, unknown>;

function readSchema(fileName: string): JsonSchema {
  return JSON.parse(fs.readFileSync(path.resolve('schemas', fileName), 'utf8')) as JsonSchema;
}

const rawDomainSchema = readSchema('domain.schema.json');

export const domainSchema = { ...rawDomainSchema };
delete domainSchema.$schema;
export const domainSchemaId = String(domainSchema.$id);

export function domainRef(definition: string): JsonSchema {
  return { $ref: `${domainSchemaId}#/$defs/${definition}` };
}

export const errorResponses = {
  400: domainRef('errorResponse'),
  403: domainRef('errorResponse'),
  404: domainRef('errorResponse'),
  409: domainRef('errorResponse'),
  500: domainRef('errorResponse')
};
