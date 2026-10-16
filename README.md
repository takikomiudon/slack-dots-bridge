# LINE → Slack → Dots 中継

個人のLINE公式アカウント「Dots」（`@638fnwlr`）から、Slackの `#チャンネル-サンプル` にメンションを送り、Dotsのスレッド返信をLINEへ返します。登録したLINEユーザー1人からのテキストと画像を受け付けます。

## 公開先

- Worker: https://line-dots-bridge.line-dots-bridge.workers.dev
- ヘルスチェック: `/health`
- LINE Webhook: `/line`
- Slack Events API: `/slack`

Cloudflare WorkersとSQLite Durable Objectで動作します。PCを起動しておく必要はありません。モデルのAPIキーは使用せず、Slackに接続したDotsへ依頼します。CloudflareとLINEそれぞれの契約プラン・利用上限が適用されます。

## 設定済みの外部サービス

LINEチャネル `2012039161` のWebhookを有効にし、定型の応答メッセージを無効にしています。

Slackアプリ `line-dots-bridge`（`A0C9E19LY83`）は、User OAuthの `chat:write` と `groups:history` を使用します。Socket Modeを無効にし、`message.groups` の購読先を `/slack` に設定しています。権限自体は参加中のプライベートチャンネルに及びますが、中継コードは設定したチャンネル・DotsのユーザーID・スレッドだけを対象にします。

User OAuth Tokenによる投稿には、本人のユーザーIDと中継アプリのBot IDが付きます。通常のメンションだけではDotsに起動イベントが届かなかったため、Dots側にもイベント駆動の受信設定を登録・有効化しています。定期ポーリングは使いません。

Dots側の対象はチャンネル `C0C94BHMQ7R`、投稿者 `U0CAE4018L8` の新規投稿とスレッド返信です。受信後にApp ID `A0C9E19LY83`、Bot ID `B0C9EV4RASH`、Dotsへのメンションを確認して同じスレッドへ返信します。中継のWebhook設定と、このDots側のイベント設定の両方が必要です。

## 動作確認済み

2026年10月16日に、実際のLINEからの送信で確認しました。

- LINE → Worker → Slackへの投稿成功
- 通常送信のテストA・Bが別々のSlackスレッドとなり、それぞれDotsが自動返信
- LINEでAのDots返信にリプライすると、Bを開始した後でもAスレッドへ戻り、`THREAD-A-CONTINUE-OK` のLINE返送まで成功
- Dots側のイベント設定で自動起動し、約38秒後に「自動テストOK」と返信
- Slack → Worker → LINEの返送成功（`delivery_done`）
- 先行テストの「LINE接続OK」は、LINE端末での受信もユーザーが確認済み
- 署名のない本番リクエストは401。LINE公式Webhook接続テストとSlack URL検証は成功
- ローカルの自動テスト30件と構文チェックは成功（通常送信・引用返信・複数スレッド・再起動・旧データ移行を含む）

## ローカルでの検証と公開

Node.js 24以降（組み込み `node:sqlite` を使うテストが動くバージョン）で実行します。

```sh
npm ci --ignore-scripts
npm test
npm run check
npx wrangler deploy --dry-run
npx wrangler login
npm run deploy
```

秘密情報はリポジトリ外の `../../work/line-dots.env` に保存しています。チャットやGitには値を貼らないでください。Cloudflareでは以下をWorker Secretsへ登録済みです。

- `SLACK_USER_TOKEN`
- `SLACK_SIGNING_SECRET`
- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_ALLOWED_USER_ID`

秘密情報を更新した場合は、このディレクトリから次を実行します。

```sh
npx wrangler secret bulk ../../work/line-dots.env
```

チャンネルやDotsの宛先は `wrangler.jsonc` のvarsで指定します。

## 配信と障害の確認

LINEとSlackの署名を検証し、受信イベントを永続キューに保存してから直ちに応答します。実際の配信はDurable ObjectのAlarmで処理します。同じイベントIDは重複送信しません。

- LINEで通常送信：毎回、新しいSlackスレッドを作成します。
- LINEでDotsのメッセージを長押しして［リプライ］：そのメッセージに対応するSlackスレッドへ送信します。別の会話を始めた後でも、元の会話を継続できます。

LINE送信APIが返す `sentMessages[].id` とSlackスレッドを永続保存し、Webhookの `quotedMessageId` で返信先を照合します。どちらの検索も主キーを使います。長文を分割した場合も各メッセージIDを保存します。既存の単一スレッドは移行時に保持し、新しく届くDots返信をLINEへ返します。

変更前にLINEへ送信済みのメッセージIDは保存されていないため、そこへの引用返信は対応先を特定できません。対応情報のない引用返信は `Unknown LINE quoted message` として配信失敗を記録し、Slackには投稿しません。変更後に届いたDotsの返信へリプライしてください。

```sh
npx wrangler tail --format pretty
```

配信完了は `delivery_done`、失敗は `delivery_failed` とジョブID・原因を記録します。HTTP 200のWebhook応答だけでは外部への配信完了を意味しません。メッセージ本文とトークンをアプリログに出力しません。

外部APIのタイムアウトなど、送信済みか判断できない失敗は自動再送しません。キューの `failed` / `sending` 状態を残します。Slackの実際の投稿を確認したうえで再送の要否を判断してください。再起動後もスレッドとキューは保持されます。

## LINEからの画像送信

LINEに送ったJPEG・PNG・GIF・WebP画像を、元のバイト列のままSlackの非公開チャンネルへ添付します。上限は1枚10 MiBです。画像の再圧縮・変換は行わず、CloudflareのDBには画像IDと配信状態だけを保存します。画像本体は転送中だけメモリに保持し、読み込み上限を超えた時点で取得を中止します。

通常の画像送信は新しいSlackスレッドを作ります。添付を共有し終えてから同じスレッドでDotsをメンションするため、添付前にDotsが起動する順序にはしません。Dotsの返信は既存の仕組みでLINEへ返します。複数枚を送った場合は1枚ずつ別のスレッドになります。

追加でSlackアプリのUser OAuth権限 `files:write` が必要です。Slackへの再インストール後、トークンの権限をAPIで確認します。ファイルを公開URLに変換する処理はありません。LINE上の保存期限切れ、サイズ上限超過、権限不足などは `delivery_failed` と原因を記録します。

## 対応範囲

- LINEの個人トークからのテキスト・画像送信
- Dotsによる、対応するSlackスレッド内の新規テキスト返信
- LINEの文字数上限を超える回答の分割

10 MiBを超える画像、外部URLを使う画像プロバイダー、ファイル・音声・グループトーク、Slack上の既存返信の編集反映は対象外です。メッセージと配信状態はDurable Objectに保存されます。

返信先の識別仕様は、LINE公式の[引用メッセージの受信](https://developers.line.biz/ja/docs/messaging-api/receiving-messages/#receive-quote-messages)と[送信時のメッセージID取得](https://developers.line.biz/ja/docs/messaging-api/get-quote-tokens/#get-quote-tokens-in-response)に基づいています。
