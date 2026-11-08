import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/models.dart';
import '../state/chat_controller.dart';

/// 單則訊息的字數上限。必須和後端的 USER_MESSAGE_MAX_CHARS 一致(預設 500;
/// 上限是成本控制的一環:每次請求都要把使用者訊息與歷史重送給模型並計費)。
const kMaxMessageChars = 500;

class ChatView extends StatefulWidget {
  const ChatView({super.key, required this.character, required this.controller});

  final Character character;
  final ChatController controller;

  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> with WidgetsBindingObserver {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _focus = FocusNode();

  ChatController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(_onScroll);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _scroll.dispose();
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// 視窗回到前景:補抓可能漏掉的訊息,並接回進行中的回覆
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) c.syncNewer();
  }

  /// 列表是 reverse 的,maxScrollExtent 是「最舊」那端。接近時載入更早的訊息。
  void _onScroll() {
    if (_scroll.hasClients && _scroll.position.pixels >= _scroll.position.maxScrollExtent - 200) {
      c.loadOlder();
    }
  }

  Future<void> _send() async {
    final text = _input.text;
    if (text.trim().isEmpty || c.busy) return;
    _input.clear();
    _focus.requestFocus();
    await c.send(text);
    // 點數不足等「根本沒送出」的情況,把文字還給輸入框
    if (c.sendError != null && _input.text.isEmpty) {
      _input.text = text;
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final msgs = c.messages.reversed.toList(); // 新的在前 → reverse ListView 讓它顯示在底部
        return Column(
          children: [
            _Header(character: widget.character),
            const Divider(height: 1),
            Expanded(
              child: c.loading
                  ? const Center(child: CircularProgressIndicator())
                  : c.loadError != null
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(c.loadError!),
                          TextButton(onPressed: c.load, child: const Text('重試')),
                        ],
                      ),
                    )
                  : ListView.builder(
                      controller: _scroll,
                      reverse: true,
                      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                      itemCount: msgs.length + 1,
                      itemBuilder: (context, i) {
                        if (i == msgs.length) {
                          // 最上方:載入更早訊息的指示 / 對話起點
                          return Padding(
                            padding: const EdgeInsets.all(12),
                            child: Center(
                              child: c.loadingOlder
                                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                                  : Text(c.hasMoreOlder ? '' : '— 對話的開始 —', style: TextStyle(color: Colors.grey.shade400, fontSize: 12)),
                            ),
                          );
                        }
                        final m = msgs[i];
                        return _Bubble(
                          key: ValueKey(m.id),
                          message: m,
                          character: widget.character,
                          onRetry: m.status == MessageStatus.failed && !m.isUser && m.canRetry ? c.retryLast : null,
                        );
                      },
                    ),
            ),
            if (c.sendError != null)
              Container(
                width: double.infinity,
                color: c.insufficientPoints ? const Color(0xFFFFF4E5) : const Color(0xFFFEECEC),
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
                child: Text(c.sendError!, style: TextStyle(color: c.insufficientPoints ? Colors.orange.shade900 : Colors.red.shade800)),
              ),
            _Composer(controller: _input, focus: _focus, busy: c.busy, onSend: _send, price: widget.character.price),
          ],
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.character});

  final Character character;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
      child: Row(
        children: [
          Text(character.avatar, style: const TextStyle(fontSize: 28)),
          const SizedBox(width: 12),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(character.name, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              Text(character.tagline, style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
            ],
          ),
        ],
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({super.key, required this.message, required this.character, this.onRetry});

  final ChatMessage message;
  final Character character;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final isUser = message.isUser;
    final streaming = message.status == MessageStatus.streaming;
    final failed = message.status == MessageStatus.failed;
    final scheme = Theme.of(context).colorScheme;
    final text = message.content;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isUser) ...[
            Container(
              width: 34,
              height: 34,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: const Color(0xFFF1EEFF), borderRadius: BorderRadius.circular(11)),
              child: Text(character.avatar, style: const TextStyle(fontSize: 18)),
            ),
            const SizedBox(width: 10),
          ],
          Flexible(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Column(
                crossAxisAlignment: isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                children: [
                  GestureDetector(
                    onSecondaryTap: () => Clipboard.setData(ClipboardData(text: text)),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      decoration: BoxDecoration(
                        color: isUser ? scheme.primary : (failed ? const Color(0xFFFEF3F2) : Colors.white),
                        borderRadius: BorderRadius.only(
                          topLeft: const Radius.circular(16),
                          topRight: const Radius.circular(16),
                          bottomLeft: Radius.circular(isUser ? 16 : 4),
                          bottomRight: Radius.circular(isUser ? 4 : 16),
                        ),
                        border: failed ? Border.all(color: const Color(0xFFFDA29B)) : null,
                        boxShadow: isUser
                            ? null
                            : [BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 6, offset: const Offset(0, 2))],
                      ),
                      child: text.isEmpty && streaming
                          ? const _TypingDots()
                          : SelectableText.rich(
                              TextSpan(
                                children: [
                                  TextSpan(
                                    text: text,
                                    style: TextStyle(color: isUser ? Colors.white : Colors.black87, fontSize: 15, height: 1.45),
                                  ),
                                  if (streaming)
                                    TextSpan(
                                      text: ' ▍',
                                      style: TextStyle(color: scheme.primary),
                                    ),
                                ],
                              ),
                            ),
                    ),
                  ),
                  if (failed)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.error_outline, size: 14, color: Colors.red.shade400),
                          const SizedBox(width: 4),
                          Text(message.failureText, style: TextStyle(color: Colors.red.shade400, fontSize: 12)),
                          if (onRetry != null)
                            TextButton(
                              onPressed: onRetry,
                              style: TextButton.styleFrom(
                                padding: const EdgeInsets.symmetric(horizontal: 8),
                                minimumSize: Size.zero,
                                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              ),
                              child: const Text('重試(不會重複扣點)', style: TextStyle(fontSize: 12)),
                            ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots> with SingleTickerProviderStateMixin {
  late final AnimationController _a = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat();

  @override
  void dispose() {
    _a.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _a,
      builder: (_, _) => Row(
        mainAxisSize: MainAxisSize.min,
        children: List.generate(3, (i) {
          final t = ((_a.value * 3) - i).clamp(0.0, 1.0);
          final o = 0.3 + 0.7 * (1 - (2 * t - 1).abs());
          return Container(
            width: 7,
            height: 7,
            margin: const EdgeInsets.symmetric(horizontal: 2, vertical: 6),
            decoration: BoxDecoration(
              color: Colors.grey.withValues(alpha: o),
              shape: BoxShape.circle,
            ),
          );
        }),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({required this.controller, required this.focus, required this.busy, required this.onSend, required this.price});

  final TextEditingController controller;
  final FocusNode focus;
  final bool busy;
  final VoidCallback onSend;
  final int price;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Focus(
              // Enter 送出,Shift+Enter 換行。
              // 中文/日文等輸入法在「組字、選字」時按 Enter 是用來確認選字,不是送出:
              // 此時輸入框的 composing 範圍有效,必須放行(ignored)讓輸入法處理。
              // (原本用 CallbackShortcuts 會無條件攔截 Enter,所以選字時會誤送出。)
              onKeyEvent: (node, event) {
                final isEnter = event.logicalKey == LogicalKeyboardKey.enter || event.logicalKey == LogicalKeyboardKey.numpadEnter;
                if (!isEnter || event is! KeyDownEvent) return KeyEventResult.ignored;
                if (HardwareKeyboard.instance.isShiftPressed) return KeyEventResult.ignored; // 換行
                final composing = controller.value.composing;
                if (composing.isValid && !composing.isCollapsed) return KeyEventResult.ignored; // 正在選字
                if (!busy) onSend();
                return KeyEventResult.handled;
              },
              child: TextField(
                controller: controller,
                focusNode: focus,
                autofocus: true,
                minLines: 1,
                maxLines: 5,
                maxLength: kMaxMessageChars,
                // 只在接近上限(80%)時才顯示字數,平常不打擾;到上限時輸入框就不再接受字元
                buildCounter: (_, {required currentLength, required isFocused, maxLength}) =>
                    currentLength >= kMaxMessageChars * 0.8
                        ? Text('$currentLength / $maxLength',
                            style: TextStyle(fontSize: 12, color: currentLength >= kMaxMessageChars ? Colors.red : Colors.grey))
                        : null,
                decoration: InputDecoration(
                  hintText: busy ? 'AI 回覆中…' : '輸入訊息(Enter 送出 · Shift+Enter 換行)',
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          Tooltip(
            message: '每則回覆 $price 點',
            child: FilledButton(
              onPressed: busy ? null : onSend,
              style: FilledButton.styleFrom(
                minimumSize: const Size(52, 48),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: busy
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Icon(Icons.arrow_upward),
            ),
          ),
        ],
      ),
    );
  }
}
