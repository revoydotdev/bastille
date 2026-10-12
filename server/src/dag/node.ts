/**
 * DAG node context.
 *
 * The engine performs no I/O, reads no ambient clock, and calls no ambient
 * RNG — every external dependency that would otherwise force the engine to
 * touch `Date.now()`, `Math.random()`, the network, the filesystem or the
 * database is injected here. Node `run` callbacks must read time, randomness,
 * budget, and logging through this object, never the ambient process.
 */
export interface Clock {
  /** Returns the current epoch time in milliseconds. */
  now(): number;
}

export interface Rng {
  /** Returns a uniformly distributed number in [0, 1). */
  next(): number;
}

export interface Budget {
  /** Read spent against the budget so far. */
  readonly spent: number;
  /** Hard ceiling for the run. */
  readonly ceiling: number;
  /** Report that one read was consumed. Returns the new spent count. */
  recordRead(): number;
  /** Throw `BudgetExhaustedError` if the ceiling is hit. */
  assertAvailable(): void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, meta?: unknown): void;
}

/**
 * Transport handle. The current todo does not exercise it; the slot exists so
 * downstream todos can wire the network plane without reshaping the contract.
 * A pure `post` is the smallest non-leaky surface we can agree on now.
 */
export interface Transport {
  post(url: string, body: unknown): Promise<{ status: number; body: unknown }>;
}

export interface NodeCtx {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly budget: Budget;
  readonly logger: Logger;
  readonly transport: Transport;
  /** Inputs supplied by the caller, available to every node's `run`. */
  readonly inputs: Record<string, unknown>;
}
