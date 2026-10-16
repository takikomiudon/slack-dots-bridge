const candidates = [
  { thread: 'movie-a', messages: [{ role: 'user', text: '2026年10月17日、109シネマズ木場で15:25から映画を見るのでカレンダーに登録してください。', images: [] }, { role: 'assistant', text: '10月17日15:25〜18:25、109シネマズ木場の予定を登録しました。', images: [] }] },
  { thread: 'essay-a', messages: [{ role: 'user', text: 'A社のエントリーシートの自己PRを添削してください。研究で作ったアプリの話を書いています。', images: [] }, { role: 'assistant', text: 'A社の自己PRは、研究の工夫と成果を中心にまとめる構成を提案します。', images: [] }] },
  { thread: 'movie-b', messages: [{ role: 'user', text: '10月24日、新宿ピカデリーで18時から映画を観る予定を登録してください。', images: [] }, { role: 'assistant', text: '10月24日18時、新宿ピカデリーの予定を登録しました。', images: [] }] },
];

function sample(name, lastThread, lastText, incoming, expected) {
  return { name, expected, context: { candidates, lineHistory: [{ role: 'assistant', thread: lastThread, text: lastText }], incoming: { text: incoming, images: [] } } };
}

export const routingCases = [
  sample('implicit movie reminder', 'movie-a', '木場の映画の予定を登録しました。', '開始30分前に通知して', 'movie-a'),
  sample('short essay continuation', 'essay-a', 'A社の自己PRの修正案です。', 'もっと短くして', 'essay-a'),
  sample('return to older movie', 'essay-a', 'A社の自己PRの修正案です。', '木場の映画の予定を取り消して', 'movie-a'),
  sample('different company new task', 'essay-a', 'A社の自己PRの修正案です。', 'B社の志望動機をゼロから考えて', 'NEW'),
  sample('new reservation same domain', 'movie-a', '木場の映画の予定を登録しました。', '11月2日、池袋で観る別の映画の予約を登録して', 'NEW'),
  sample('specific nonlatest movie', 'movie-a', '木場の映画の予定を登録しました。', '新宿の映画は午後7時開始に変更して', 'movie-b'),
  sample('ambiguous referent', 'movie-a', '木場の映画も新宿の映画も日程変更できます。どちらのことですか？', 'そっちにして', 'CLARIFY'),
  sample('multiple independent tasks', 'movie-a', '木場の映画の予定を登録しました。', '木場の映画の予定を消して。それとA社のESも短くして', 'CLARIFY'),
  sample('approval of displayed proposal', 'essay-a', 'A社の自己PRをこの構成で書き直してよいですか？', 'はい、その内容で進めて', 'essay-a'),
  sample('acknowledgment', 'movie-a', '木場の映画の予定を登録しました。', 'ありがとう', 'movie-a'),
  sample('related outing followup', 'movie-a', '木場の映画の予定を登録しました。', 'その映画のあと、近くで晩ご飯を食べる店も探して', 'movie-a'),
  sample('no recoverable referent', 'essay-a', 'A社の自己PRの修正案です。', '例のやつと同じようにして。どれかは覚えてない', 'CLARIFY'),
];
