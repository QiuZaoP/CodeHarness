import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialSnapshot } from '../data/mockData';
import { workspaceApi } from '../services/api';
import { workspaceEvents } from '../services/events';
import type { WorkspaceEvent } from '../types';
import { useWorkspace, WorkspaceProvider } from './WorkspaceContext';

function Conversation() {
  const { snapshot } = useWorkspace();
  if (!snapshot) return null;
  return (
    <div>
      {(snapshot.messages[snapshot.activeSessionId] || []).map((message) => (
        <p key={message.id}>{message.content}</p>
      ))}
    </div>
  );
}

function SendButton({ content }: { content: string }) {
  const { sendMessage } = useWorkspace();
  return <button onClick={() => void sendMessage(content)}>send</button>;
}

function RollbackButton() {
  const { rollbackTask, snapshot } = useWorkspace();
  return (
    <>
      <button onClick={() => void rollbackTask()}>rollback</button>
      <span data-testid="change-count">{snapshot?.changes.length ?? 0}</span>
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkspaceProvider task events', () => {
  it('shows the persisted completion summary once', async () => {
    const snapshot = structuredClone(initialSnapshot);
    let emit: ((event: WorkspaceEvent) => void) | undefined;
    vi.spyOn(workspaceApi, 'getSnapshot').mockResolvedValue(snapshot);
    vi.spyOn(workspaceApi, 'getSessionState').mockResolvedValue({
      messages: [
        ...(snapshot.messages[snapshot.activeSessionId] || []),
        {
          id: '00000000-0000-4000-8000-000000000042',
          role: 'assistant',
          content: 'Completed repository inspection and verified the result.',
          createdAt: '00:00'
        }
      ],
      task: snapshot.task,
      changes: snapshot.changes
    });
    vi.spyOn(workspaceEvents, 'subscribe').mockImplementation((_taskId, onEvent) => {
      emit = onEvent;
      return () => undefined;
    });

    render(
      <WorkspaceProvider>
        <Conversation />
      </WorkspaceProvider>
    );

    await waitFor(() => expect(emit).toBeDefined());
    const completion: WorkspaceEvent = {
      schemaVersion: '1.0.0',
      id: 42,
      taskId: snapshot.task.id,
      type: 'task.completed',
      timestamp: '2026-07-29T00:00:00.000Z',
      payload: {
        messageId: '00000000-0000-4000-8000-000000000042',
        summary: 'Completed repository inspection and verified the result.',
        verification: { command: 'npm test', code: 0 }
      }
    };

    act(() => emit?.(completion));
    expect(
      await screen.findByText('Completed repository inspection and verified the result.')
    ).toBeInTheDocument();

    act(() => emit?.(completion));
    expect(
      screen.getAllByText('Completed repository inspection and verified the result.')
    ).toHaveLength(1);
  });

  it('replaces the optimistic user message with the persisted backend message', async () => {
    const snapshot = {
      ...structuredClone(initialSnapshot),
      activeSessionId: 'session-new',
      sessions: [
        {
          id: 'session-new',
          projectId: initialSnapshot.activeProjectId,
          title: 'New task',
          preview: '',
          updatedAt: 'now',
          status: 'idle' as const
        }
      ],
      messages: { 'session-new': [] },
      task: { ...initialSnapshot.task, id: '', status: 'CREATED' as const }
    };
    vi.spyOn(workspaceApi, 'getSnapshot').mockResolvedValue(snapshot);
    vi.spyOn(workspaceEvents, 'subscribe').mockImplementation(() => () => undefined);
    vi.spyOn(workspaceApi, 'sendMessage').mockResolvedValue({
      message: {
        id: '00000000-0000-4000-8000-000000000001',
        role: 'user',
        content: 'Explain the project entry',
        createdAt: '02:30'
      },
      task: {
        id: '00000000-0000-4000-8000-000000000002',
        sessionId: 'session-new',
        projectId: initialSnapshot.activeProjectId,
        goal: 'Explain the project entry',
        status: 'CREATED',
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z'
      }
    });

    render(
      <WorkspaceProvider>
        <SendButton content="Explain the project entry" />
        <Conversation />
      </WorkspaceProvider>
    );

    fireEvent.click(await screen.findByText('send'));

    await waitFor(() => {
      expect(screen.getAllByText('Explain the project entry')).toHaveLength(1);
    });
  });

  it('shows the persisted reason and keeps a waiting task resumable', async () => {
    const snapshot = structuredClone(initialSnapshot);
    let emit: ((event: WorkspaceEvent) => void) | undefined;
    vi.spyOn(workspaceApi, 'getSnapshot').mockResolvedValue(snapshot);
    vi.spyOn(workspaceEvents, 'subscribe').mockImplementation((_taskId, onEvent) => {
      emit = onEvent;
      return () => undefined;
    });

    render(
      <WorkspaceProvider>
        <Conversation />
      </WorkspaceProvider>
    );

    await waitFor(() => expect(emit).toBeDefined());
    act(() =>
      emit?.({
        schemaVersion: '1.0.0',
        id: 43,
        taskId: snapshot.task.id,
        type: 'task.waiting_user',
        timestamp: '2026-07-29T00:00:00.000Z',
        payload: { message: 'Planning needs to be retried.' }
      })
    );

    expect(await screen.findByText('Planning needs to be retried.')).toBeInTheDocument();
  });

  it('clears the active diff after a successful rollback', async () => {
    const snapshot = structuredClone(initialSnapshot);
    vi.spyOn(workspaceApi, 'getSnapshot').mockResolvedValue(snapshot);
    vi.spyOn(workspaceEvents, 'subscribe').mockImplementation(() => () => undefined);
    vi.spyOn(workspaceApi, 'rollbackTask').mockResolvedValue(undefined);

    render(
      <WorkspaceProvider>
        <RollbackButton />
      </WorkspaceProvider>
    );

    expect(await screen.findByTestId('change-count')).toHaveTextContent(
      String(snapshot.changes.length)
    );
    fireEvent.click(screen.getByText('rollback'));

    await waitFor(() => expect(screen.getByTestId('change-count')).toHaveTextContent('0'));
  });
});
