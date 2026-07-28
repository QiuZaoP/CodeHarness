import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceApi } from './api';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspaceApi real backend contract', () => {
  it('hydrates the workspace from the versioned list endpoints', async () => {
    const responses = new Map<string, unknown>([
      ['/api/health', { status: 'ok' }],
      [
        '/api/v1/projects',
        [{ id: 'project-1', name: 'demo', createdAt: '2026-01-01T00:00:00.000Z' }]
      ],
      ['/api/v1/projects/project-1/files', { files: ['README.md', 'src/login.ts'] }],
      [
        '/api/v1/sessions?projectId=project-1',
        [
          {
            id: 'session-1',
            projectId: 'project-1',
            title: 'Fix login',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      ],
      [
        '/api/v1/tasks?sessionId=session-1',
        [
          {
            id: 'task-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            goal: 'Fix login',
            status: 'READY_FOR_REVIEW',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:01:00.000Z'
          }
        ]
      ],
      [
        '/api/v1/sessions/session-1/messages',
        [
          {
            id: 'message-1',
            sessionId: 'session-1',
            role: 'USER',
            content: 'Fix login',
            createdAt: '2026-01-01T00:00:00.000Z'
          },
          {
            id: 'message-2',
            sessionId: 'session-1',
            role: 'ASSISTANT',
            content: 'Fixed login and verified the result.',
            createdAt: '2026-01-01T00:01:00.000Z'
          }
        ]
      ],
      [
        '/api/v1/tasks/task-1/changes',
        [
          {
            id: 'change-1',
            taskId: 'task-1',
            path: 'src/login.ts',
            status: 'MODIFIED',
            additions: 1,
            deletions: 1,
            patch: '@@ -1,1 +1,1 @@\n-old\n+new',
            decision: 'PENDING',
            version: 3
          }
        ]
      ]
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname + new URL(String(input)).search;
        const body = responses.get(path);
        return body === undefined
          ? jsonResponse({ error: 'unexpected path' }, 404)
          : jsonResponse(body);
      })
    );

    const snapshot = await createWorkspaceApi('http://api.test').getSnapshot();

    expect(snapshot.activeProjectId).toBe('project-1');
    expect(snapshot.fileTree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'README.md', type: 'file' }),
        expect.objectContaining({ name: 'src', type: 'folder' })
      ])
    );
    expect(snapshot.activeSessionId).toBe('session-1');
    expect(snapshot.messages['session-1']?.[0]?.role).toBe('user');
    expect(snapshot.messages['session-1']?.[1]).toMatchObject({
      id: 'message-2',
      role: 'assistant',
      content: 'Fixed login and verified the result.'
    });
    expect(snapshot.task.status).toBe('READY_FOR_REVIEW');
    expect(snapshot.changes[0]).toMatchObject({
      id: 'change-1',
      taskId: 'task-1',
      status: 'modified',
      decision: 'pending',
      version: 3
    });
    expect(snapshot.changes[0]?.hunks[0]?.lines).toHaveLength(2);
  });

  it('persists messages and uses the resume and optimistic review endpoints', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown; contentType?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({
          path: url.pathname,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          contentType: new Headers(init?.headers).get('Content-Type') || undefined
        });
        if (url.pathname.endsWith('/messages')) {
          return jsonResponse(
            {
              id: 'message-1',
              sessionId: 'session-1',
              role: 'USER',
              content: 'Fix login',
              createdAt: '2026-01-01T00:00:00.000Z'
            },
            201
          );
        }
        if (url.pathname === '/api/v1/tasks') {
          return jsonResponse(
            {
              id: 'task-1',
              sessionId: 'session-1',
              projectId: 'project-1',
              goal: 'Fix login',
              status: 'CREATED',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            },
            201
          );
        }
        if (url.pathname.endsWith('/resume')) {
          return jsonResponse({ status: 'EXECUTING' }, 202);
        }
        if (url.pathname.endsWith('/apply')) {
          return jsonResponse({
            id: 'task-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            goal: 'Fix login',
            status: 'APPLIED',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:01:00.000Z'
          });
        }
        return jsonResponse({
          id: 'change-1',
          taskId: 'task-1',
          path: 'src/login.ts',
          status: 'MODIFIED',
          additions: 1,
          deletions: 0,
          patch: '@@ -1,0 +1,1 @@\n+fixed',
          decision: 'ACCEPTED',
          version: 4
        });
      })
    );
    const api = createWorkspaceApi('http://api.test');

    await api.sendMessage('session-1', 'project-1', 'Fix login');
    await api.controlTask('task-1', 'resume');
    const change = await api.decideChange('task-1', 'change-1', 'accepted', 3);
    await api.applyTask('task-1');

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          path: '/api/v1/sessions/session-1/messages',
          method: 'POST',
          body: { content: 'Fix login' },
          contentType: 'application/json'
        },
        {
          path: '/api/v1/tasks/task-1/resume',
          method: 'POST',
          body: undefined,
          contentType: undefined
        },
        {
          path: '/api/v1/tasks/task-1/changes/change-1',
          method: 'PATCH',
          body: { decision: 'ACCEPTED', expectedVersion: 3 },
          contentType: 'application/json'
        },
        {
          path: '/api/v1/tasks/task-1/apply',
          method: 'POST',
          body: undefined,
          contentType: undefined
        }
      ])
    );
    expect(change).toMatchObject({ decision: 'accepted', version: 4 });
  });
});
