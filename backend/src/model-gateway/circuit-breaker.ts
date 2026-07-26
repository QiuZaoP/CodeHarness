import { isRetryableFailure, ModelGatewayError } from './errors.ts';

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now
  ) {}

  async execute<T>(action: () => Promise<T>): Promise<T> {
    this.beforeCall();
    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (error) {
      if (isRetryableFailure(error)) this.onFailure();
      else this.onNonRetryableFailure();
      throw error;
    }
  }

  snapshot(): { state: CircuitState; failures: number; openedAt: number } {
    return { state: this.state, failures: this.failures, openedAt: this.openedAt };
  }

  private beforeCall(): void {
    if (this.state === 'CLOSED') return;
    if (this.state === 'OPEN' && this.now() - this.openedAt < this.cooldownMs) {
      throw new ModelGatewayError('Model provider circuit is open', 'CIRCUIT_OPEN', {
        retryAfterMs: Math.max(0, this.cooldownMs - (this.now() - this.openedAt))
      }, 503);
    }
    this.state = 'HALF_OPEN';
  }

  private onSuccess(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.openedAt = 0;
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }

  private onNonRetryableFailure(): void {
    if (this.state === 'HALF_OPEN') this.onSuccess();
  }
}
