// INVARIANT:
// - Applies decisions to execution
// - MUST NOT calculate pressure or read Lag/ELU

import type { ControlDecision } from '../control/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskOptions = {
  priority?: number;
};

export type ShedReason =
  | 'pressure_high'
  | 'queue_overflow'
  | 'probabilistic_shedding';

export type LimiterResult<T> =
  | { status: 'executed'; value: T }
  | { status: 'shed'; reason: ShedReason };

export type LimiterOptions = {
  /** キューの最大長。デフォルト: 1000 */
  maxQueue?: number;
};

// ---------------------------------------------------------------------------
// Internal queue entry
// ---------------------------------------------------------------------------

type QueueEntry = {
  priority: number;
  resolve: () => void;
};

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

/**
 * control 層の ControlDecision に従い、
 * concurrency 制御・キュー管理・shedding を実行する。
 */
export class Limiter {
  private readonly maxQueue: number;
  private decision: ControlDecision | null = null;
  private running = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(options: LimiterOptions = {}) {
    this.maxQueue = options.maxQueue ?? 1000;
  }

  /**
   * 制御方針を更新する。
   * control 層（または外部テスト）から呼び出される。
   */
  updateDecision(decision: ControlDecision): void {
    this.decision = decision;
    this.drain();
  }

  /**
   * タスクを投入する。
   * concurrency に空きがあれば即時実行、なければキューに入るか shed される。
   */
  async submit<T>(
    fn: () => Promise<T>,
    options: TaskOptions = {},
  ): Promise<LimiterResult<T>> {
    const priority = options.priority ?? 0;
    const decision = this.decision;

    // decision が未設定の場合は制限なしで実行
    if (decision === null) {
      return this.execute(fn);
    }

    // --- Shedding 判定 ---

    // 1. 確率的 shedding
    if (
      decision.shedProbability > 0 &&
      Math.random() < decision.shedProbability
    ) {
      return { status: 'shed', reason: 'probabilistic_shedding' };
    }

    // 2. concurrency に空きがあれば即時実行
    if (this.running < decision.targetConcurrency) {
      return this.execute(fn);
    }

    // 3. キュー溢れ shedding
    if (this.queue.length >= this.maxQueue) {
      return { status: 'shed', reason: 'queue_overflow' };
    }

    // 4. キューに追加して待機
    await this.enqueue(priority);

    // キューから復帰後に実行
    return this.execute(fn);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async execute<T>(fn: () => Promise<T>): Promise<LimiterResult<T>> {
    this.running++;
    try {
      const value = await fn();
      return { status: 'executed', value };
    } finally {
      this.running--;
      this.drain();
    }
  }

  private enqueue(priority: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry: QueueEntry = { priority, resolve };

      // priority 降順で挿入位置を探す（高い priority が先頭に近い）
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1]!.priority < priority) {
        i--;
      }
      this.queue.splice(i, 0, entry);
    });
  }

  private drain(): void {
    if (this.decision === null) return;

    while (
      this.queue.length > 0 &&
      this.running < this.decision.targetConcurrency
    ) {
      const entry = this.queue.shift();
      if (entry) {
        entry.resolve();
      }
    }
  }
}
