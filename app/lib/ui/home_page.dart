import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../models/models.dart';
import '../state/app_state.dart';
import 'chat_view.dart';
import 'ledger_dialog.dart';

class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        return Scaffold(
          body: Row(
            children: [
              SizedBox(width: 320, child: _Sidebar(state: state)),
              const VerticalDivider(width: 1),
              Expanded(child: _Main(state: state)),
            ],
          ),
        );
      },
    );
  }
}

class _Sidebar extends StatelessWidget {
  const _Sidebar({required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final b = state.balance;
    return Container(
      color: Colors.white,
      child: Column(
        children: [
          // 使用者與點數
          Container(
            padding: const EdgeInsets.fromLTRB(16, 20, 16, 12),
            child: Row(
              children: [
                CircleAvatar(
                  backgroundColor: Theme.of(context).colorScheme.primaryContainer,
                  child: Text((state.nickname ?? '?').characters.first.toUpperCase()),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(state.nickname ?? '', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                      Text('@${state.username ?? ''}', style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
                    ],
                  ),
                ),
                PopupMenuButton<String>(
                  icon: const Icon(Icons.more_horiz),
                  onSelected: (v) {
                    if (v == 'logout') state.logout();
                    if (v == 'delete') _confirmDelete(context);
                  },
                  itemBuilder: (_) => const [
                    PopupMenuItem(value: 'logout', child: Text('登出')),
                    PopupMenuItem(
                      value: 'delete',
                      child: Text('刪除帳號…', style: TextStyle(color: Colors.red)),
                    ),
                  ],
                ),
              ],
            ),
          ),
          InkWell(
            onTap: () => showLedger(context, state),
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 16),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                gradient: const LinearGradient(colors: [Color(0xFF6D4AFF), Color(0xFF9B7BFF)]),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Row(
                children: [
                  const Icon(Icons.bolt, color: Colors.white),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('點數', style: TextStyle(color: Colors.white70, fontSize: 12)),
                        Text(
                          '${b?.available ?? '—'}',
                          style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800),
                        ),
                      ],
                    ),
                  ),
                  if (b != null && b.held > 0) Text('回覆中 −${b.held}', style: const TextStyle(color: Colors.white70, fontSize: 12)),
                  const Icon(Icons.chevron_right, color: Colors.white70),
                ],
              ),
            ),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(20, 20, 16, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('角色', style: TextStyle(fontWeight: FontWeight.w700)),
            ),
          ),
          Expanded(
            child: ListView(
              children: [for (final c in state.characters) _CharacterTile(state: state, character: c)],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmDelete(BuildContext context) async {
    final pw = TextEditingController();
    String? error;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setS) => AlertDialog(
          title: const Text('刪除帳號'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('所有對話紀錄與點數明細都會被永久刪除,無法復原。請輸入密碼確認。'),
              const SizedBox(height: 12),
              TextField(
                controller: pw,
                obscureText: true,
                decoration: InputDecoration(labelText: '密碼', errorText: error),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: Colors.red),
              onPressed: () async {
                try {
                  await state.deleteAccount(pw.text);
                  if (ctx.mounted) Navigator.pop(ctx, true);
                } on ApiException catch (e) {
                  setS(() => error = e.message);
                }
              },
              child: const Text('永久刪除'),
            ),
          ],
        ),
      ),
    );
    if (ok == true && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('帳號已刪除')));
    }
  }
}

class _CharacterTile extends StatelessWidget {
  const _CharacterTile({required this.state, required this.character});

  final AppState state;
  final Character character;

  @override
  Widget build(BuildContext context) {
    final selected = state.selectedCharacterId == character.id;
    final conv = state.conversationsByCharacter[character.id];
    return Material(
      color: selected ? const Color(0xFFEFEAFF) : Colors.transparent,
      child: InkWell(
        onTap: () => state.openCharacter(character),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(
            children: [
              Container(
                width: 46,
                height: 46,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: const Color(0xFFF1EEFF), borderRadius: BorderRadius.circular(14)),
                child: Text(character.avatar, style: const TextStyle(fontSize: 24)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(character.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                        const Spacer(),
                        Text('${character.price} 點/則', style: TextStyle(color: Colors.grey.shade500, fontSize: 11)),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      conv != null && conv.lastPreview.isNotEmpty ? conv.lastPreview : character.tagline,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Main extends StatelessWidget {
  const _Main({required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final chat = state.chat;
    final character = state.characters.where((c) => c.id == state.selectedCharacterId).firstOrNull;
    if (character == null) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('💬', style: TextStyle(fontSize: 56)),
            SizedBox(height: 8),
            Text('選一位角色,開始聊天', style: TextStyle(fontSize: 16)),
          ],
        ),
      );
    }
    if (chat == null) {
      if (state.lastError != null) return Center(child: Text(state.lastError!));
      return const Center(child: CircularProgressIndicator());
    }
    return ChatView(key: ValueKey(chat.conversationId), character: character, controller: chat);
  }
}
