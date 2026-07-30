import { AppError } from './errors.js';
import type { TaskStatus } from './types.js';

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  CREATED: ['PRECHECKING', 'PAUSED', 'CANCELLED'],
  PRECHECKING: ['PLANNING', 'WAITING_USER', 'PAUSED', 'FAILED', 'CANCELLED'],
  PLANNING: ['EXECUTING', 'WAITING_USER', 'PAUSED', 'FAILED', 'CANCELLED'],
  EXECUTING: [
    'EXECUTING',
    'VERIFYING',
    'READY_FOR_REVIEW',
    'WAITING_USER',
    'PAUSED',
    'FAILED',
    'CANCELLED'
  ],
  VERIFYING: ['EXECUTING', 'READY_FOR_REVIEW', 'PAUSED', 'FAILED', 'CANCELLED'],
  READY_FOR_REVIEW: ['APPLIED', 'EXECUTING', 'CANCELLED'],
  APPLIED: [],
  WAITING_USER: ['PLANNING', 'EXECUTING', 'VERIFYING', 'PAUSED', 'CANCELLED', 'FAILED'],
  PAUSED: ['PLANNING', 'EXECUTING', 'VERIFYING', 'CANCELLED'],
  CANCELLED: [],
  FAILED: []
};

const terminalStatuses = new Set<TaskStatus>(['APPLIED', 'CANCELLED', 'FAILED']);

export class TaskStateMachine {
  assertTransition(from: TaskStatus, to: TaskStatus): void {
    if (!this.canTransition(from, to)) {
      throw new AppError(
        'CONFLICT',
        `Invalid task transition: ${from} -> ${to}`,
        { from, to },
        409
      );
    }
  }

  canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return transitions[from].includes(to);
  }

  isTerminal(status: TaskStatus): boolean {
    return terminalStatuses.has(status);
  }

  pauseResumeTarget(
    status: TaskStatus
  ): Extract<TaskStatus, 'PLANNING' | 'EXECUTING' | 'VERIFYING'> {
    if (status === 'CREATED' || status === 'PRECHECKING' || status === 'PLANNING') {
      return 'PLANNING';
    }
    if (status === 'EXECUTING' || status === 'VERIFYING') return status;
    throw new AppError('CONFLICT', `Task cannot be paused from ${status}`, { status }, 409);
  }
}

export const taskStateMachine = new TaskStateMachine();

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  taskStateMachine.assertTransition(from, to);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return taskStateMachine.canTransition(from, to);
}
