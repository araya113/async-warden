/**
 * 手動テスト用スクリプト
 *
 * 実行方法:
 *   npm run build && node examples/basic.mjs
 */
import { Warden } from "../dist/index.js";

const warden = new Warden({ intervalMs: 200 });

console.log("=== Warden manual test ===\n");

// 1. start 前の submit（制限なしで即時実行）
const r1 = await warden.submit(() => Promise.resolve("hello"));
console.log("1. submit before start:", r1);

// 2. start
warden.start();
console.log("2. started");

// 制御ループが数回回るのを待つ
await new Promise((r) => setTimeout(r, 600));

// 3. 単発 submit
const r2 = await warden.submit(async () => 42);
console.log("3. submit after start:", r2);

// 4. 並列 submit
const results = await Promise.all([
  warden.submit(() => Promise.resolve("a")),
  warden.submit(() => Promise.resolve("b")),
  warden.submit(() => Promise.resolve("c")),
]);
console.log("4. parallel submit:", results);

// 5. 負荷をかけて制御ループの動作を確認
console.log("\n5. load test (100 tasks):");
const start = performance.now();
const loadResults = await Promise.all(
  Array.from({ length: 100 }, (_, i) =>
    warden.submit(async () => {
      // 軽い非同期処理
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      return i;
    }),
  ),
);
const elapsed = (performance.now() - start).toFixed(1);
const executed = loadResults.filter((r) => r.status === "executed").length;
const shed = loadResults.filter((r) => r.status === "shed").length;
console.log(`   executed: ${executed}, shed: ${shed}, elapsed: ${elapsed}ms`);

// 6. stop
warden.stop();
console.log("\n6. stopped");
