# Slack DM → Decisions → Dots 中継

Slackアプリ **Dots Bridge** の[専用DM](https://app.slack.com/client/T0C9HPM0NAJ/D0C9Y063EKH)へ送ったテキスト・画像を、OpenAI Decisions APIで会話ごとに振り分け、`#チャンネル-サンプル` の該当スレッドへ本人名義で投稿します。Dotsの返信は専用DMへ返します。

Cloudflare WorkersとSQLite Durable Objectで動作するため、PCの常時起動は不要です。返信の生成はSlackに接続したDots、振り分けはDecisions API（`gpt-6-luna`）が担当します。分類用の指示や別の会話の内容はDotsへ投稿しません。

## 使い方と分類

- 通常のDM：既存スレッド・新規会話・確認が必要な入力へ分類します。
- 対象を特定できない入力：DMに候補ボタンを表示して投稿を保留します。ページ切り替え、新規会話、キャンセルに対応します。
- DM内で既存メッセージへスレッド返信：保存済みの対応先を使い、分類APIを呼ばずに同じ会話へ送ります。

分類は入力ごとに1回です。候補が0件の場合もAPIを呼びません。選択ボタンを押した後に再分類しません。APIエラーや不正な結果から宛先を推測する処理はありません。

登録済みスレッドの原文、画像、受信・返信の順序を分類へ渡します。LINE運用時に保存した会話と履歴も引き継ぎます。既存スレッドの履歴は初回のみ取り込み、以後はSlackイベントで更新します。履歴の取り込みによって過去の返信をDMへ再送しません。

## 画像・表示

JPEG・PNG・GIF・WebPを1投稿10枚まで受け付けます。入力画像の合計は10 MiBまでです。取得したバイト列を分類と転送で共有し、再圧縮や公開URL化は行いません。DBへ画像本体は保存しません。分類へ渡す画像証拠もSHA-256で重複を除き、合計10 MiBまでに制限します。上限超過は原因を記録して失敗にします。

画像は本文・Dotsへのメンションとともに1つの親投稿、または既存スレッドへまとめて共有します。「画像」だけの仮投稿や固定の依頼文は付けません。Slackの共有イベントに含まれる正確なファイルIDから投稿先を登録します。Dotsの返信が先に届いた場合は、対応するスレッドの登録まで待機します。

返信はDotsのSlack本文と表示ブロックをそのままDMへ転送し、段落や箇条書きを保持します。音声、画像以外の添付、既存投稿の編集・削除の同期は対象外です。

## 設定

- Worker：`https://line-dots-bridge.line-dots-bridge.workers.dev`
- ヘルスチェック：`GET /health`
- Slackイベント：`POST /slack`
- Slack選択ボタン：`POST /slack/actions`
- Slackアプリ：`Dots Bridge`（`A0C9E19LY83`）

アプリの権限と購読：

| 種類 | 設定 |
| --- | --- |
| User OAuth | `chat:write`、`groups:history`、`files:write`、`files:read` |
| Bot OAuth | `chat:write`、`im:history`、`im:write` |
| Userイベント | `message.groups` |
| Botイベント | `message.im` |
| App Home | Messagesタブを有効化し、書き込み可能にする |
| Interactivity | 有効化し `/slack/actions` を指定 |

コードは設定済みのワークスペース・本人・専用DM・転送先チャンネルに制限します。OAuth権限自体は専用DMや転送先チャンネルだけには限定されません。チャンネルへの投稿にはUser Token、専用DMへの返送にはBot Tokenを使います。Botの返送イベントを入力として再処理しません。

Dots側には、本人のUser OAuth投稿に付く中継アプリID・Bot IDとメンションを確認して起動するイベント設定が登録済みです。定期ポーリングは使いません。

秘密情報はリポジトリ外の `../../work/line-dots.env`（権限600）に保存し、以下の5項目をWorker Secretsへ反映しています。値をチャットやGitへ貼らないでください。

- `SLACK_USER_TOKEN`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_DM_CHANNEL_ID`
- `OPENAI_API_KEY`

ワークスペース・チャンネル・本人・DotsのIDは `wrangler.jsonc` のvarsで設定します。秘密情報を変更した場合は、このディレクトリで実行します。

```sh
npx wrangler secret bulk ../../work/line-dots.env
```

## LINE廃止

LINEの送受信コードを撤去し、`/line` はHTTP 410を返します。LINE用の送信トークンは失効済みで、旧トークンでの認証が401になることを確認しました。LINE用の3項目はローカル環境ファイルとWorker Secretsから削除済みです。未完了のLINEジョブは廃止状態にし、会話と履歴は保持します。

2026年10月20日にLINE Developersへ再ログインし、「Webhookの利用」もオフにしました。サーバー側・LINE側ともに中継を停止しています。LINE公式アカウント自体の削除は行っていません。既存のSlack購読URLを維持するため、Worker名と公開URLには旧名称が残っています。

## 検証・公開

Node.js 24以降（テストで組み込み`node:sqlite`を使用）で実行します。

```sh
npm ci --ignore-scripts
npm test
npm run check
npx wrangler deploy --dry-run
npm run deploy
```

自動テスト30件が成功しています。署名・所有者の制限、分類1回、新規・既存会話、DMスレッド返信、重複イベント、選択ボタン、複数画像、イベント順序の入れ替わり、再起動、LINE廃止を含みます。workerd・SQLite Durable Object・Alarmによる統合テストでは外部APIをテスト応答へ差し替えています。

```sh
npm run eval:routing
```

上記は実際のDecisions APIを呼び、API料金が発生します。日本語の架空ケース15件は期待どおりでした。実運用の精度を保証する結果ではありません。

2026年10月20日の本番では、異なる2つの新規会話が別々のチャンネル親投稿になり、Dotsの回答が専用DMへ返ることを確認しました。その後、通常のDMで元の企画名を指定した続きが最初のスレッドへ投稿され、`SLACK-DM-A-CONTINUE2-OK`のDM返送まで確認しました。一方、その前に送った続きの入力1件は転送が確認できておらず、原因は未確定です。Cloudflareの過去ログ参照にはWorkers Observabilityの追加権限が必要です。画像と選択ボタンの本番確認も未完了です。

## 配信と障害

Slack署名と5分以内のタイムスタンプを検証し、イベントを永続キューへ保存して応答します。外部APIへの配信はAlarmで実行します。同じイベントIDを重複登録しません。DM内の選択操作は本人・ワークスペース・専用DM・保存済み候補を検証します。

ログは分類結果を`route_selected`、処理結果を`delivery_state`、失敗を`delivery_failed`としてジョブID・状態・原因とともに記録します。アプリログには本文やトークンを出力しません。WebhookのHTTP 200だけでは転送完了を意味しません。

```sh
npx wrangler tail --format pretty
```

外部送信の成否を判断できない失敗は、自動再送せず`failed` / `sending`として保持します。実際の投稿と原因を調べてから再送の要否を判断してください。通常のキュー・会話・DMとスレッドの対応は再起動後も保持します。
