# Kamen（仮称）

身元を明かさずに物理イベントへ参加登録・入場できる、ビットコイナー向けのオープンソースWebアプリ（PWA）。
仕様の正本は docs/SPEC.md。実装前に必ず該当章を読むこと。仕様と矛盾する判断が必要なときは、実装せずに質問する。

## 絶対に守るルール（プライバシー）

- 参加者のメール・氏名・電話番号・npubを収集するコードを書かない。任意項目としても追加しない。
- サーバーはIPアドレス・User-AgentをログにもDBにも残さない。リクエストログはパスとステータスのみ。
- チケット発行時のブラインド値（B_）を保存しない。発行と支払い、発行と消し込みを結びつける列を作らない。
- Cookie、アクセス解析、外部CDN・外部フォントの読み込みを入れない。資産はすべて同梱する。
- 参加者の秘密（チケット、使い捨て鍵、スタンプ）はブラウザのIndexedDBにのみ置く。サーバーへ送らない。
- サーバーは資金を預からない。支払いは主催者のウォレットへNWC経由で直接入れる。
- 新しいテーブル・列・ログ出力を足したら、docs/PRIVACY.md の「サーバーが見るもの・保存するもの」を同じコミットで更新する。

## 構成

- pnpmワークスペース、TypeScript（strict）
- apps/web: React + Vite + vite-plugin-pwa + Tailwind CSS + shadcn/ui
- apps/server: Node.js + Hono + SQLite（Drizzle）
- packages/core: ブラインド署名（Cashu BDHKE）、DLEQ、トークン符号化。ブラウザとサーバーで共用
- packages/messaging: MessagingAdapterインターフェースとmarmot-ts実装

## 進め方

- 暗号処理を自作しない。監査されたライブラリ（@noble/curves、cashu-tsの暗号プリミティブ）を使い、Cashu NUTの公式テストベクターで検証する。
- 外部ライブラリ（特にmarmot-ts、cashu-ts、@getalby/sdk）は、使う前に最新のREADMEと型定義を読む。記憶にあるAPIを前提にしない。バージョンは固定する。
- marmot-tsはアルファ版。呼び出しは packages/messaging の中だけに閉じ込め、アプリ側は MessagingAdapter だけを使う。
- UIはスマホ優先。日本語と英語に対応する（文言は辞書ファイルに分離）。
- 各機能にテストを書く（Vitest。主要フローはPlaywright）。pnpm test と pnpm lint が通ってから完了とする。
- コミットは小さく、日本語でも英語でもよいが内容が分かるメッセージにする。
