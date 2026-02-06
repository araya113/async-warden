# async-warden 使い方ガイド

## インストール

```bash
npm install async-warden
```

## クイックスタート

```ts
import { Warden } from "async-warden";

const warden = new Warden();

// 制御ループを開始
warden.start();

// タスクを投入
const result = await warden.submit(async () => {
  return await fetch("https://api.example.com/data");
});

if (result.status === "executed") {
  console.log(result.value);
} else {
  // shedding された
  console.log("shed:", result.reason);
}

// 制御ループを停止
warden.stop();
```

## API

### `new Warden(options?)`

Warden インスタンスを生成する。各層のオプションまたはインスタンスを渡せる。

```ts
const warden = new Warden({
  intervalMs: 500,
  controller: {
    lagThresholdMs: 50,
    eluThreshold: 0.7,
    maxConcurrency: 50,
  },
  limiter: {
    maxQueue: 200,
  },
});
```

#### `WardenOptions`

| パラメータ | 型 | デフォルト | 説明 |
|-----------|---|-----------|------|
| `intervalMs` | `number` | `1000` | 制御ループの実行間隔（ms） |
| `monitor` | `MonitorOptions \| Monitor` | 内部生成 | Monitor の設定またはインスタンス |
| `controller` | `ControllerOptions \| Controller` | 内部生成 | Controller の設定またはインスタンス |
| `limiter` | `LimiterOptions \| Limiter` | 内部生成 | Limiter の設定またはインスタンス |

### `warden.start()`

Monitor の計測を開始し、`intervalMs` 間隔で制御ループを起動する。

### `warden.stop()`

制御ループを停止し、Monitor の計測を終了する。

### `warden.submit(fn, options?)`

タスクを投入する。結果は `LimiterResult<T>` で返る。

```ts
const result = await warden.submit(async () => {
  return await doWork();
});
```

#### `TaskOptions`

| パラメータ | 型 | デフォルト | 説明 |
|-----------|---|-----------|------|
| `priority` | `number` | `0` | 値が大きいほど優先的にキューから取り出される |

#### `LimiterResult<T>`

```ts
// 実行された場合
{ status: "executed"; value: T }

// shedding された場合
{ status: "shed"; reason: ShedReason }
```

#### `ShedReason`

| 値 | 発生条件 |
|---|---------|
| `"probabilistic_shedding"` | 高負荷時に確率的に shed |
| `"queue_overflow"` | キューが `maxQueue` に達した |

## オプション詳細

### MonitorOptions

| パラメータ | デフォルト | 説明 |
|-----------|-----------|------|
| `resolution` | `20` | Event Loop Delay の計測解像度（ms） |

### ControllerOptions

| パラメータ | デフォルト | 説明 |
|-----------|-----------|------|
| `lagThresholdMs` | `100` | Lag の閾値（ms）。これを超えると pressure が上昇する |
| `eluThreshold` | `0.8` | ELU の閾値（0-1）。これを超えると pressure が上昇する |
| `lagWeight` | `0.5` | pressure 計算における Lag の重み |
| `eluWeight` | `0.5` | pressure 計算における ELU の重み |
| `ewmaAlpha` | `0.3` | EWMA の平滑化係数。大きいほど最新値に敏感 |
| `maxConcurrency` | `100` | 同時実行数の上限 |
| `minConcurrency` | `1` | 同時実行数の下限 |
| `increaseStep` | `1` | pressure 低下時の concurrency 増加幅（AI: Additive Increase） |
| `decreaseFactor` | `0.5` | pressure 上昇時の concurrency 乗算係数（MD: Multiplicative Decrease） |

### LimiterOptions

| パラメータ | デフォルト | 説明 |
|-----------|-----------|------|
| `maxQueue` | `1000` | キューの最大長。溢れたタスクは `queue_overflow` で shed される |

## 制御ループの仕組み

`start()` を呼ぶと以下のループが `intervalMs` 間隔で実行される:

```
Monitor.sample() → Controller.update(sample) → Limiter.updateDecision(decision)
```

1. **Monitor** がイベントループの Lag と ELU を計測する
2. **Controller** が計測値から pressure を算出し、AIMD アルゴリズムで `targetConcurrency` と `shedProbability` を決定する
3. **Limiter** が決定に基づいてタスクの実行・キューイング・shedding を行う

## 使用例: HTTP サーバでの load shedding

```ts
import http from "node:http";
import { Warden } from "async-warden";

const warden = new Warden({
  intervalMs: 500,
  controller: { maxConcurrency: 50 },
});
warden.start();

const server = http.createServer(async (req, res) => {
  const result = await warden.submit(async () => {
    // リクエスト処理
    return { data: "ok" };
  });

  if (result.status === "executed") {
    res.writeHead(200);
    res.end(JSON.stringify(result.value));
  } else {
    res.writeHead(503);
    res.end(JSON.stringify({ error: "service unavailable", reason: result.reason }));
  }
});

server.listen(3000);

process.on("SIGTERM", () => {
  warden.stop();
  server.close();
});
```

## 使用例: 優先度付きタスク

```ts
// 重要なリクエストは高い priority を設定
const important = await warden.submit(() => handlePayment(), { priority: 10 });

// 通常のリクエスト
const normal = await warden.submit(() => handlePageView(), { priority: 0 });
```

高負荷時にキューが詰まった場合、`priority` が高いタスクが先にキューから取り出される。
