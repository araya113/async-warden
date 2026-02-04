/**
 * Shedding 発生確認用スクリプト
 *
 * イベントループをブロックする重い処理を大量に投入し、
 * Warden が shedding を発生させることを確認する。
 *
 * 実行方法:
 *   npm run build && node examples/shedding.mjs
 */
import { Warden } from "../dist/index.js";

// 閾値を低く設定して shedding を起こしやすくする
const warden = new Warden({
  intervalMs: 100,
  controller: {
    lagThresholdMs: 20, // デフォルト 100 → 20 に下げる
    eluThreshold: 0.3, // デフォルト 0.8 → 0.3 に下げる
    maxConcurrency: 10,
    decreaseFactor: 0.5,
  },
  limiter: {
    maxQueue: 5, // キューを小さく設定して queue_overflow を起こしやすくする
  },
});

/** イベントループをブロックする重い同期処理 */
function heavyWork(durationMs) {
  const end = Date.now() + durationMs;
  let sum = 0;
  while (Date.now() < end) {
    sum += Math.random();
  }
  return sum;
}

warden.start();
console.log("=== Shedding test ===\n");

// 制御ループが数回回ってベースラインを取るのを待つ
await new Promise((r) => setTimeout(r, 500));

// --- Phase 1: イベントループに負荷をかけて pressure を上げる ---
console.log("Phase 1: Raising event loop pressure...\n");

for (let i = 0; i < 3; i++) {
  heavyWork(100); // 同期的にブロック
  await new Promise((r) => setTimeout(r, 150)); // 制御ループが反応する時間
}

// --- Phase 2: 負荷がかかった状態で大量タスクを投入 ---
console.log("Phase 2: Submitting 50 tasks under pressure...\n");

// バックグラウンドで継続的に負荷をかける
const loadInterval = setInterval(() => heavyWork(30), 50);

const results = await Promise.all(
  Array.from({ length: 50 }, (_, i) =>
    warden.submit(async () => {
      // 各タスクも少し重い処理をする
      heavyWork(5);
      return i;
    }),
  ),
);

clearInterval(loadInterval);

// --- 集計 ---
const executed = results.filter((r) => r.status === "executed");
const shed = results.filter((r) => r.status === "shed");

const reasons = {};
for (const r of shed) {
  const reason = r.reason;
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

console.log(`Results: ${executed.length} executed, ${shed.length} shed`);
if (Object.keys(reasons).length > 0) {
  console.log("Shed reasons:", reasons);
}

warden.stop();
console.log("\nDone.");
