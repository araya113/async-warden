# Limiter Behavior

このドキュメントは **async-warden における limiter 層の振る舞い** を定義します。

ここで定義される内容は、
実装詳細ではなく **挙動と責務の不変条件（behavioral invariants）** です。

limiter 層は、control 層が下した判断を
**一貫性のある・説明可能な形で実行フローに反映する** ことを目的とします。

---

## Role of the limiter

limiter の責務は次の一点に集約されます。

> **「判断された制御方針を、実行・待機・拒否という具体的挙動に落とすこと」**

limiter は以下を行います。

* 同時実行数の制御（adaptive concurrency）
* 実行待ちキューの管理
* 優先度に基づく実行順制御
* shedding（拒否）の実行と理由付け

一方で、limiter は以下を **行いません**。

* Lag / ELU の直接参照
* 圧力（pressure）の計算
* 制御量の決定ロジック

---

## Inputs to the limiter

limiter は次の入力のみを受け取ります。

### 1. ControlDecision

control 層から提供される判断結果です。

* `targetConcurrency`
* `shedProbability`
* `reasons`

limiter はこの decision を **現在の制御方針** として扱います。

---

### 2. Execution request (task)

limiter に投入される実行要求は、
最低限次のメタデータを持つことが想定されます。

* `priority`
* `deadline`（任意）

これらは limiter 内でのみ使用され、
control 層には逆流しません。

---

## Core behaviors

### 1. Adaptive concurrency

limiter は `targetConcurrency` を
**現在許可されている最大同時実行数** として扱います。

* 実行中タスク数 < targetConcurrency

  * 新規タスクを即時実行
* 実行中タスク数 ≥ targetConcurrency

  * タスクはキューに入る、または shedding 対象になる

concurrency の増減は limiter 自身では決定しません。

---

### 2. Queueing behavior

limiter は内部に実行待ちキューを持ちます。

キューに関する基本方針は以下です。

* 無制限キューは持たない
* 最大キュー長は明示的に設定される remind
* キュー溢れは shedding 理由となる

キューは **優先度付き** で管理されます。

---

### 3. Priority handling

各タスクは priority を持ちます。

priority は以下の目的で使用されます。

* 実行順序の決定
* shedding 時の生存判定

高優先度タスクは、

* 低優先度タスクより先に実行される
* shedding 時に残りやすい

priority は **実行順制御のための概念** であり、
制御判断そのものではありません。

---

### 4. Deadline awareness

タスクは optional な deadline を持つことができます。

deadline を持つタスクは次のように扱われます。

* 期限超過が確定したタスクは実行しない
* shedding 理由は `deadline_exceeded`

これにより、

* 価値のない実行を避ける
* 無意味な Event Loop 負荷を減らす

ことを目的とします。

---

### 5. Shedding behavior

limiter は以下の状況で shedding を行います。

* キューが上限に達した場合
* `shedProbability` に基づく確率的拒否
* 低優先度タスクが圧迫している場合
* deadline 超過が確定した場合

shedding は **最後の手段** として扱われます。

---

## Shedding reasons

shedding が発生した場合、
limiter は必ず理由を明示します。

代表的な理由コードの例：

* `pressure_high`
* `queue_overflow`
* `probabilistic_shedding`
* `priority_drop`
* `deadline_exceeded`

理由は単なる文字列ではなく、
**運用・デバッグで説明可能な情報** として扱われます。

---

## Explainability requirements

limiter は、拒否・遅延・実行のいずれの場合でも、
次の情報と結び付けられる必要があります。

* 当時の ControlDecision
* タスクの priority / deadline
* 実行・拒否の直接的理由

「なぜこのタスクが落とされたのか」を
後から説明できない実装は設計違反です。

---

## Forbidden patterns

以下は limiter 層において **明確な設計違反** です。

* Lag / ELU を直接参照する
* control ロジックを limiter に持ち込む
* 固定値によるハードな同時実行数制限
* 理由を伴わない拒否
* 実行中タスクの強制中断

---

## Interaction with other layers

* limiter は monitor に依存しない
* limiter は control の decision を信頼する
* limiter から上位層へのフィードバックは

  * ログ
  * イベント
  * フック
    などの **観測用途** に限定される

制御ループを直接形成してはなりません。

---

## For contributors and AI tools

このドキュメントは、
limiter 実装を変更する際の **行動規範** です。

変更前に必ず確認してください。

* これは limiter の責務か
* control の判断を侵食していないか
* shedding の理由は説明できるか

実装が正しく動いていても、
設計意図を壊す変更は受け入れられません。

---

## Summary

* limiter は「判断を実行に落とす層」
* concurrency は adaptive に制御される
* queue / priority / deadline を扱う
* shedding は説明可能である必要がある
* 判断ロジックは持たない

これらの原則は、
async-warden の limiter 層における不変条件です。
