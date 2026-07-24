import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { contractSchemaVersion } from '../src/contract-values.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const domainSchema = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'schemas/domain.schema.json'), 'utf8')
) as object;
const eventSchema = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'schemas/event.schema.json'), 'utf8')
) as object;

function contractValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
  addFormats(ajv);
  ajv.addSchema(domainSchema);
  return ajv.compile(eventSchema);
}

describe('public contract schemas', () => {
  it('accepts every versioned event payload contract', () => {
    const validate = contractValidator();
    const plan = {
      goal: 'Inspect fixture',
      assumptions: [],
      steps: [{ id: 'inspect', title: 'Inspect', status: 'PENDING' }],
      verification: ['npm test']
    };
    const fixtures: Array<{ type: string; payload: object }> = [
      { type: 'task.created', payload: { goal: 'Inspect fixture' } },
      {
        type: 'task.state_changed',
        payload: { from: 'CREATED', to: 'PRECHECKING' }
      },
      { type: 'task.plan.updated', payload: { plan } },
      { type: 'tool.started', payload: { toolName: 'read_file' } },
      {
        type: 'tool.completed',
        payload: { toolName: 'read_file', result: { bytes: 12 } }
      },
      {
        type: 'task.completed',
        payload: { verification: { command: 'npm test', code: 0 } }
      },
      { type: 'task.failed', payload: { message: 'Model failed' } },
      { type: 'task.waiting_user', payload: { message: 'Confirm command' } },
      { type: 'task.paused', payload: { status: 'PAUSED' } },
      { type: 'task.resumed', payload: { status: 'EXECUTING' } },
      { type: 'task.cancelled', payload: { reason: 'Cancelled by user' } },
      { type: 'task.applied', payload: { changeCount: 2 } },
      {
        type: 'verification.completed',
        payload: {
          verification: {
            id: 'e2a69a67-71bc-4b46-8291-57b01c6c783b',
            taskId: '06bf418f-22f0-4e9e-902a-a2f5aca06160',
            command: 'npm test',
            status: 'PASSED',
            exitCode: 0,
            outputSummary: '8 tests passed',
            createdAt: '2026-07-24T00:00:00.000Z'
          }
        }
      },
      {
        type: 'change.updated',
        payload: {
          changeId: 'e2a69a67-71bc-4b46-8291-57b01c6c783b',
          decision: 'ACCEPTED'
        }
      }
    ];

    for (const [index, fixture] of fixtures.entries()) {
      const event = {
        schemaVersion: contractSchemaVersion,
        id: index + 1,
        taskId: '06bf418f-22f0-4e9e-902a-a2f5aca06160',
        type: fixture.type,
        timestamp: '2026-07-24T00:00:00.000Z',
        payload: fixture.payload
      };
      expect(validate(event), `${fixture.type}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(validate({ ...event, payload: { unexpected: true } }), fixture.type).toBe(false);
    }
  });

  it('rejects incompatible event versions and payloads', () => {
    const validate = contractValidator();
    const event = {
      schemaVersion: '2.0.0',
      id: 1,
      taskId: '06bf418f-22f0-4e9e-902a-a2f5aca06160',
      type: 'task.state_changed',
      timestamp: '2026-07-24T00:00:00.000Z',
      payload: { from: 'CREATED', to: 'NOT_A_STATUS' }
    };

    expect(validate(event)).toBe(false);
  });
});
