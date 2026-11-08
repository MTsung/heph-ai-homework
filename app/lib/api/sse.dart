import 'dart:async';
import 'dart:convert';

/// 一個 SSE 事件。
class SseEvent {
  const SseEvent(this.event, this.data, {this.id});

  final String event;
  final Object? data;
  final String? id;

  Map<String, dynamic> get json => (data as Map).cast<String, dynamic>();

  @override
  String toString() => 'SseEvent($event, $data)';
}

/// 把位元組串流解析成 SSE 事件。
///
/// 重點:網路封包的切分點是任意的(可能切在一個中文字的 UTF-8 位元組中間,
/// 也可能切在事件中間),所以要用 [utf8.decoder] 的串流模式處理跨封包的多位元組字元,
/// 並自己累積到遇到空行(\n\n)才算一個完整事件。
/// 以 `:` 開頭的行是註解(伺服器的心跳),直接忽略。
Stream<SseEvent> parseSse(Stream<List<int>> bytes) async* {
  final buffer = StringBuffer();
  await for (final chunk in utf8.decoder.bind(bytes)) {
    buffer.write(chunk);
    var text = buffer.toString();
    var idx = text.indexOf('\n\n');
    while (idx >= 0) {
      final block = text.substring(0, idx);
      text = text.substring(idx + 2);
      final ev = _parseBlock(block);
      if (ev != null) yield ev;
      idx = text.indexOf('\n\n');
    }
    buffer
      ..clear()
      ..write(text);
  }
}

SseEvent? _parseBlock(String block) {
  String event = 'message';
  String? id;
  final data = StringBuffer();
  var hasData = false;
  for (final line in block.split('\n')) {
    if (line.isEmpty || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.substring(6).trim();
    } else if (line.startsWith('id:')) {
      id = line.substring(3).trim();
    } else if (line.startsWith('data:')) {
      if (hasData) data.write('\n');
      data.write(line.substring(5).trimLeft());
      hasData = true;
    }
  }
  if (!hasData) return null; // 只有註解/心跳
  try {
    return SseEvent(event, jsonDecode(data.toString()), id: id);
  } catch (_) {
    return null; // 壞掉的事件直接略過,不要讓整條串流中斷
  }
}
