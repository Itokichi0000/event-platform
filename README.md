# Kamen（仮称）

身元を明かさずに物理イベントへ参加登録・入場できる、ビットコイナー向けのオープンソースWebアプリ（PWA）。

> **このサーバーのデータベースには、参加者を表すテーブルが存在しません。**
>
> 名前・メール・電話番号・npub の入力欄はありません。チケットはブラインド署名で発行されるため、
> サーバーも主催者も「誰に発行したチケットが入場に使われたか」を計算で結びつけることができません。
> サーバーが見るもの・保存するものは [docs/PRIVACY.md](docs/PRIVACY.md) にすべて列挙しています。

## しくみ（概要）

1. 参加者のブラウザが乱数の秘密値 `x` を作り、ブラインド化した `B_` だけをサーバーに送る。
2. サーバーは `B_` に署名して返す。`B_` は保存しない。
3. ブラウザがブラインドを外し、チケット `(x, C)` を端末内（IndexedDB）にだけ保存する。
4. 受付で QR を見せると、サーバーは署名を検証して `x` を使用済みにする。

手順2で見た `B_` と手順4で見た `x` を結びつける方法はありません。暗号は
[Cashu](https://github.com/cashubtc/nuts) の BDHKE（NUT-00）と DLEQ 証明（NUT-12）をそのまま使い、
公式テストベクターで検証しています。ただしチケットに金銭的価値はなく、サーバーは資金を一切預かりません。

詳しい設計は [docs/SPEC.md](docs/SPEC.md) を参照してください。

## 現在の状態

フェーズ4（遊びと発展）まで実装済み。無料・招待制・有料（Lightning）のイベントを作り、名前もメールも入れずに
チケットを受け取り、受付で入場できます。参加者はイベントごとの使い捨て鍵で、暗号化チャット（Marmot）に入れます。

| パッケージ           | 内容                                                                                        | 状態     |
| -------------------- | ------------------------------------------------------------------------------------------- | -------- |
| `packages/core`      | BDHKE、DLEQ、鍵セット、QR 用トークン符号化、PoW                                             | 実装済み |
| `apps/server`        | Hono + SQLite の API（NIP-98、PoW・招待コード・NWC による発行、消し込み、返却、削除ジョブ） | 実装済み |
| `apps/web`           | 参加者 PWA・主催者ダッシュボード・受付スキャナー（オフライン受付、日本語／英語）            | 実装済み |
| `packages/messaging` | `MessagingAdapter` と Marmot 実装（marmot-ts 0.9.0、アルファ版）                            | 実装済み |

フェーズ2で入ったもの：有料チケット（主催者のウォレットへ NWC で直接入金）、招待コード、共同主催者、
オフライン受付、チケット返却、日本語／英語の切替、終了48時間後の秘密鍵・支払い記録の削除。
手動確認の手順は [docs/TESTING.md](docs/TESTING.md) を参照してください。

フェーズ3で入ったもの：参加者用の暗号化チャット「仮面ルーム」（Marmot / MLS）。チケットと同時に入室パスを受け取り、
イベントごとの使い捨て鍵で入ります。ルームは**既定でオフ**です。使うときは `.env` の `ROOM_RELAYS` にリレーを書き、`docker compose --profile rooms up -d --build` で起動します。
**ルームエージェント（このサーバー）はルームの会話を読めます**（[docs/PRIVACY.md](docs/PRIVACY.md)）。
調査と実装の記録は [docs/MARMOT-NOTES.md](docs/MARMOT-NOTES.md) にあります。

フェーズ4で入ったもの：

- 御朱印帳（受付で主催者の御朱印を受け取り、常連優先枠のイベントで提示できる）
- 匿名の投票・質問・抽選（受付で受け取る投票資格を使う）
- デポジット（hold invoice。入場すれば返金、来なければ主催者が受け取る）
- 承認制（申請者の npub を主催者が確認。**承認制のイベントだけ npub を保存します**）
- ルーム内の両想い開示（お互いが選んだときだけ npub を見せ合う）

抽選は賞品のない用途に限り、デポジットは法務確認を前提にしてください（[docs/SPEC.md](docs/SPEC.md) 10章）。
White Noise アプリとの相互運用は未検証です。

## 画面

| URL                | 画面                                                     |
| ------------------ | -------------------------------------------------------- |
| `/e/:id`           | イベントページ（「参加する」でチケット取得）             |
| `/tickets`         | マイチケット（オフラインでも開ける）                     |
| `/t/:id`           | チケットの QR、バックアップ                              |
| `/tickets/restore` | バックアップ文字列から復元                               |
| `/host`            | 主催者ダッシュボード（Nostr 拡張 NIP-07 でログイン）     |
| `/scan/:id#token`  | 受付スキャナー（ダッシュボードで発行したリンクから開く） |
| `/r/:eventId`      | 仮面ルーム（参加者用の暗号化チャット）                   |

## 開発

Node.js 22 以上と pnpm 10 が必要です。

```bash
pnpm install
```

API サーバーを起動します（別のターミナルで）。`KAMEN_MASTER_KEY` は鍵セットの秘密鍵を暗号化する鍵です。

```bash
cd apps/server && KAMEN_MASTER_KEY=$(openssl rand -hex 32) POW_DIFFICULTY=12 pnpm dev
```

ルームも試す場合は、テスト用リレー（`pnpm --filter @kamen/messaging relay`、ws://127.0.0.1:7777）と
ルームエージェント（`cd apps/server && pnpm agent`）を、同じ `KAMEN_MASTER_KEY` と
`ROOM_RELAYS=ws://127.0.0.1:7777` で起動し、API サーバーにも同じ `ROOM_RELAYS` を渡します。

Web を起動します。`/api` は `localhost:8787` に転送されます。

```bash
pnpm --filter @kamen/web dev
```

テスト・lint・型チェック・E2E：

```bash
pnpm test
```

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm e2e
```

## セルフホスト

VPS の用意から本番当日のチェックリストまでの詳しい手順は [docs/DEPLOY.md](docs/DEPLOY.md) にあります。

Docker Compose で、Caddy（PWA の配信と `/api` の転送、自動 HTTPS）と API サーバーが起動します。
同梱の Caddy 設定はアクセスログを残さず、IP アドレスと User-Agent を API サーバーに渡しません。

```bash
cp .env.example .env
```

`.env` の `KAMEN_MASTER_KEY`（`openssl rand -hex 32` で生成）、`KAMEN_DOMAIN`、`PUBLIC_ORIGIN` を設定します。
マスター鍵をなくすと既存イベントのチケットを検証できなくなるため、DB とは別に保管してください。

```bash
docker compose up -d --build
```

## ライセンス

[MIT](LICENSE)（公開前に AGPLv3 と比較して最終決定する予定。docs/SPEC.md 10章）
