import 'dart:convert';

import 'package:chat_app/api/sse.dart';
import 'package:flutter_test/flutter_test.dart';

/// SSE 解析器是 App 與後端串流協定的核心。這些情境都是真實網路會遇到的:
/// 封包切在事件中間、切在中文字的 UTF-8 位元組中間、伺服器心跳註解…
void main() {
  Stream<List<int>> chunks(List<List<int>> parts) => Stream.fromIterable(parts);

  test('解析完整事件', () async {
    final bytes = utf8.encode('event: delta\nid: 3\ndata: {"t":"你好"}\n\n');
    final out = await parseSse(chunks([bytes])).toList();
    expect(out, hasLength(1));
    expect(out.first.event, 'delta');
    expect(out.first.id, '3');
    expect(out.first.json['t'], '你好');
  });

  test('封包切在事件中間仍能正確組回', () async {
    final all = utf8.encode('event: delta\ndata: {"t":"abc"}\n\nevent: done\ndata: {"ok":true}\n\n');
    for (var cut = 1; cut < all.length; cut++) {
      final out = await parseSse(chunks([all.sublist(0, cut), all.sublist(cut)])).toList();
      expect(out.map((e) => e.event).toList(), ['delta', 'done'], reason: '在位元組 $cut 切開');
    }
  });

  test('封包切在中文字的 UTF-8 位元組中間,不會變成亂碼', () async {
    final all = utf8.encode('event: delta\ndata: {"t":"嗨,見到你真好"}\n\n');
    // 「嗨」是 3 個位元組;逐位元組切到最碎
    final out = await parseSse(chunks([for (final b in all) [b]])).toList();
    expect(out, hasLength(1));
    expect(out.first.json['t'], '嗨,見到你真好');
  });

  test('心跳註解與空事件被忽略', () async {
    final out = await parseSse(chunks([utf8.encode(': hb\n\n: hb\n\nevent: ready\ndata: {"ok":true}\n\n')])).toList();
    expect(out.map((e) => e.event).toList(), ['ready']);
  });

  test('壞掉的 JSON 事件略過,不中斷後面的事件', () async {
    final out = await parseSse(chunks([utf8.encode('event: x\ndata: {壞掉\n\nevent: ok\ndata: {"a":1}\n\n')])).toList();
    expect(out.map((e) => e.event).toList(), ['ok']);
  });

  test('串流結束時尚未完成(沒有空行)的事件不會被當成完整事件', () async {
    final out = await parseSse(chunks([utf8.encode('event: delta\ndata: {"t":"半截"}')])).toList();
    expect(out, isEmpty);
  });
}
