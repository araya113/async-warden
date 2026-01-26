# Decision Model

このドキュメントは **async-warden における制御判断モデル（decision model）** を定義します。

ここで定義される内容は、
数式・アルゴリズムそのものではなく、
**「どのように考えて判断を行うか」という設計思想と不変条件** です。

control 層は、この decision model に従って
**連続的・説明可能な制御判断** を行います。

---

## Purpose of the decision model

Node.js の過負荷制御において最も重要なのは、

* いつ制御を開始するか
* どの程度制御を強めるか
* いつ、どの速度で回復させるか

を **安定して判断できること** です。

async-warden の decision model は、

> **「崩壊を検知する」のではなく「崩壊を予測して回避する」**

ことを目的とします。

---

## Input signals

control 層が直接扱う入力は、monitor 層が提供する `SystemSample` のみです。

### 1. Event Loop Lag

Lag は **すでに発生している遅延の結果** を表します。

* 平均値ではなく **テイル（p90 / p99）** を重視
* 単発スパイクよりも「持続的な悪化」を重く扱う

Lag は **状態確認のシグナル** です。

---

### 2. Event Loop Utilization (ELU)

ELU は **Event Loop がどれだけ忙しいか** を表します。

* delta ベースで扱う
* 0..1 の連続値

ELU は **将来の悪化を予測する先行シグナル** です。

---

## Why Lag and ELU must be combined

Lag と ELU のどちらか一方だけでは、
誤った判断を引き起こします。

* Lag だけを見ると

  * GC や一時的スパイクに過剰反応する
* ELU だけを見ると

  * 軽い処理が多い状況でも過剰制御する

async-warden では、

> **Lag = 結果、ELU = 原因寄りの兆候**

として扱い、
**両者を組み合わせて判断** します。

---

## Pressure abstraction

control 層では、複数のシグナルを
**単一の内部状態「pressure」** に統合します。

### Properties of pressure

* 連続値（0..1）
* 「遮断するか否か」を表すものではない
* **制御の強さを決めるための内部量**

pressure は、
直接ユーザーに露出される概念ではありません。

---

### Normalization

Lag と ELU はスケールが異なるため、
そのままでは合成できません。

そのため、各シグナルは

* 0..1 に正規化され
* 緩やかなカーブ（S 字）を通して評価

されることが想定されます。

これにより、

* 小さな変動への過剰反応を避ける
* 悪化時には急激に影響を強める

という性質を持たせます。

---

### Composition

正規化された Lag / ELU は
重み付きで合成されます。

* Lag: 現在の状態の深刻度
* ELU: 近い将来の悪化可能性

重みは固定値ではなく、

* 運用特性
* ワークロード

に応じて調整可能であることを前提とします。

---

## Temporal smoothing

Event Loop の指標はノイズを含みます。

decision model では、

* 瞬間値をそのまま使わない
* 時系列的な平滑化を行う

ことを前提とします。

代表的な手法：

* EWMA（指数移動平均）
* 短期・中期ウィンドウの併用

これは **monitor でも control でも実装可能** ですが、
意味付けは control 層で行われます。

---

## Control output

pressure に基づき、control 層は
次の制御量を出力します。

* `targetConcurrency`
* `shedProbability`

これらは **段階的・連続的に変化** します。

---

### Adaptive concurrency strategy

concurrency 制御は、
以下の原則に基づきます。

* 悪化時：素早く下げる
* 回復時：ゆっくり戻す

これは、

* フラッピング防止
* 過剰遮断防止

を目的とした設計です。

AIMD（Additive Increase / Multiplicative Decrease）
に近い挙動を想定しますが、
**厳密なアルゴリズムへの固定は行いません。**

---

### Shedding probability

shedding は
**常時行われるものではありません**。

* pressure が高い
* キューが逼迫している
* 低優先度タスクが圧迫している

といった状況で、
**確率的に適用** されます。

確率的に行うことで、

* 全遮断を避ける
* システムの呼吸を保つ

ことを目的とします。

---

## Explainability

decision model は、
常に「なぜその判断になったか」を
説明できる必要があります。

そのため、control 層は

* pressure の内訳
* 支配的だったシグナル
* どの方向に制御を動かしたか

を `reasons` として保持します。

---

## Forbidden patterns

decision model における設計違反は以下です。

* 固定値のハード閾値による判断
* 単一シグナルへの依存
* 瞬間値のみでの判断
* 理由を説明できない数値更新
* limiter に判断ロジックを委譲すること

---

## For contributors and AI tools

このドキュメントは、
control 層を実装・変更する際の
**思考のフレームワーク** です。

実装前に必ず確認してください。

* この判断は予防的か
* 連続的な制御になっているか
* なぜこの数値変更が必要か説明できるか

正しく動いていても、
この decision model に反する実装は
受け入れられません。

---

## Summary

* 判断は Lag + ELU の組み合わせで行う
* pressure は内部的な連続状態
* 制御は適応的・段階的
* 回復は意図的に遅く
* 判断理由は必ず説明可能

この decision model は、
async-warden の制御思想の中核です。
