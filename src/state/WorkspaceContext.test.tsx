import { act, render, screen, waitFor } from '@testing-library/react';
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkspaceProvider task events', () => {
  it('shows the persisted completion summary once', async () => {
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
});
