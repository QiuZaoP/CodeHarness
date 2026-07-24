import { AppError } from './errors.js';
import type { TaskStatus } from './types.js';

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  CREATED: ['PRECHECKING', 'CANCELLED'],
  PRECHECKING: ['PLANNING', 'WAITING_USER', 'FAILED', 'CANCELLED'],
  PLANNING: ['EXECUTING', 'WAITING_USER', 'FAILED', 'CANCELLED'],
  EXECUTING: ['EXECUTING', 'VERIFYING', 'WAITING_USER', 'PAUSED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['EXECUTING', 'READY_FOR_REVIEW', 'FAILED', 'CANCELLED'],
  READY_FOR_REVIEW: ['APPLIED', 'EXECUTING', 'CANCELLED'],
  APPLIED: [],
  WAITING_USER: ['PLANNING', 'EXECUTING', 'PAUSED', 'CANCELLED', 'FAILED'],
  PAUSED: ['PLANNING', 'EXECUTING', 'CANCELLED'],
  CANCELLED: [],
  FAILED: []
};

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!transitions[from].includes(to)) {
    throw new AppError('CONFLICT', `Invalid task transition: ${from} -> ${to}`, { from, to }, 409);
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}
