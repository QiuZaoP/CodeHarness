import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, taskStateMachine } from '../src/state-machine.js';

describe('task state machine', () => {
  it('allows the standard lifecycle', () => {
    expect(canTransition('CREATED', 'PRECHECKING')).toBe(true);
    expect(canTransition('PRECHECKING', 'PLANNING')).toBe(true);
    expect(canTransition('PLANNING', 'EXECUTING')).toBe(true);
    expect(canTransition('EXECUTING', 'VERIFYING')).toBe(true);
    expect(canTransition('VERIFYING', 'READY_FOR_REVIEW')).toBe(true);
    expect(canTransition('VERIFYING', 'PAUSED')).toBe(true);
    expect(canTransition('PAUSED', 'VERIFYING')).toBe(true);
    expect(canTransition('READY_FOR_REVIEW', 'APPLIED')).toBe(true);
    expect(taskStateMachine.pauseResumeTarget('PRECHECKING')).toBe('PLANNING');
    expect(taskStateMachine.pauseResumeTarget('EXECUTING')).toBe('EXECUTING');
    expect(taskStateMachine.isTerminal('CANCELLED')).toBe(true);
  });

  it('rejects terminal state transitions', () => {
    expect(() => assertTransition('APPLIED', 'EXECUTING')).toThrow('Invalid task transition');
    expect(() => assertTransition('CREATED', 'APPLIED')).toThrow('Invalid task transition');
  });
});
