import type { SystemSample } from './monitor/index.js';
import type { ControlDecision } from './control/index.js';

type SampleOverrides = {
  ts?: number;
  lag?: Partial<SystemSample['lag']>;
  elu?: Partial<SystemSample['elu']>;
};

export function makeSample(overrides?: SampleOverrides): SystemSample {
  return {
    ts: overrides?.ts ?? Date.now(),
    lag: { p50: 0, p90: 0, p99: 0, mean: 0, max: 0, ...overrides?.lag },
    elu: { value: 0, ...overrides?.elu },
  };
}

export function makeDecision(overrides?: Partial<ControlDecision>): ControlDecision {
  return {
    ts: Date.now(),
    pressure: { value: 0, components: { lag: 0, elu: 0 } },
    targetConcurrency: 10,
    shedProbability: 0,
    reasons: [],
    ...overrides,
  };
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
