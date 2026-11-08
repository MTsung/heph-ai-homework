import 'package:flutter/material.dart';

import '../models/models.dart';
import '../state/app_state.dart';

/// 點數明細。使用者與客服看到的是同一份帳本(後台「使用者與點數」頁)。
Future<void> showLedger(BuildContext context, AppState state) {
  return showDialog(
    context: context,
    builder: (_) => Dialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520, maxHeight: 640),
        child: _LedgerList(state: state),
      ),
    ),
  );
}

class _LedgerList extends StatefulWidget {
  const _LedgerList({required this.state});

  final AppState state;

  @override
  State<_LedgerList> createState() => _LedgerListState();
}

class _LedgerListState extends State<_LedgerList> {
  final List<LedgerEntry> _items = [];
  bool _loading = true;
  bool _more = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    widget.state.refreshBalance();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final page = await widget.state.loadLedger(beforeId: _items.isEmpty ? null : _items.last.id);
      _items.addAll(page);
      _more = page.length >= 50;
      _error = null;
    } catch (e) {
      _error = '載入失敗';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _t(DateTime t) => '${t.month}/${t.day} ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 12, 8),
          child: Row(
            children: [
              const Text('點數明細', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              const Spacer(),
              IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
            ],
          ),
        ),
        Expanded(
          child: _items.isEmpty && _loading
              ? const Center(child: CircularProgressIndicator())
              : _items.isEmpty
              ? Center(child: Text(_error ?? '還沒有任何紀錄'))
              : ListView.separated(
                  itemCount: _items.length + (_more ? 1 : 0),
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (_, i) {
                    if (i == _items.length) {
                      return TextButton(onPressed: _loading ? null : _load, child: Text(_loading ? '載入中…' : '載入更多'));
                    }
                    final e = _items[i];
                    final plus = e.amount > 0;
                    return ListTile(
                      title: Text(e.note),
                      subtitle: Text(_t(e.createdAt)),
                      trailing: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(
                            '${plus ? '+' : ''}${e.amount}',
                            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: plus ? Colors.green.shade700 : Colors.red.shade600),
                          ),
                          Text('餘額 ${e.balanceAfter}', style: TextStyle(color: Colors.grey.shade500, fontSize: 11)),
                        ],
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }
}
