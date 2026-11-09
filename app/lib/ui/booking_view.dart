import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/booking_models.dart';
import '../state/booking_controller.dart';

class BookingFlowView extends StatefulWidget {
  const BookingFlowView({super.key, required this.controller, required this.onBack});
  final BookingController controller;
  final VoidCallback onBack;

  @override
  State<BookingFlowView> createState() => _BookingViewState();
}

class _BookingViewState extends State<BookingFlowView> with WidgetsBindingObserver {
  final _text = TextEditingController();
  final _scroll = ScrollController();

  BookingController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _text.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) c.refresh();
  }

  Future<void> _send() async {
    final text = _text.text.trim();
    if (text.isEmpty || c.busy) return;
    _text.clear();
    await c.message(text);
    if (c.error != null && _text.text.isEmpty) _text.text = text;
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final b = c.booking;
        return Column(
          children: [
            Container(
              color: Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
              child: Row(
                children: [
                  IconButton(tooltip: '回到聊天', onPressed: widget.onBack, icon: const Icon(Icons.arrow_back)),
                  const SizedBox(width: 8),
                  const Icon(Icons.restaurant_menu, color: Color(0xFF6D4AFF)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('AI 訂位代辦', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                        Text(b.status.text, style: TextStyle(fontSize: 12, color: _statusColor(b.status))),
                      ],
                    ),
                  ),
                  IconButton(tooltip: '重新整理', onPressed: c.busy ? null : c.refresh, icon: const Icon(Icons.refresh)),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: ListView(
                controller: _scroll,
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                children: [
                  _StatusCard(booking: b),
                  const SizedBox(height: 12),
                  for (final event in b.events) _EventRow(event: event),
                  if (b.pending != null) ...[const SizedBox(height: 12), _PendingCard(controller: c)],
                ],
              ),
            ),
            if (c.error != null) _Error(text: c.error!),
            if (c.canCancel)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 4, 24, 0),
                child: Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(onPressed: c.busy ? null : c.cancel, icon: const Icon(Icons.close, size: 16), label: const Text('取消這筆訂位')),
                ),
              ),
            _Composer(controller: _text, busy: c.busy || c.running, onSend: _send),
          ],
        );
      },
    );
  }
}

Color _statusColor(BookingStatus s) => switch (s) {
  BookingStatus.succeeded => Colors.green.shade700,
  BookingStatus.failed || BookingStatus.unknown || BookingStatus.expired => Colors.red.shade700,
  BookingStatus.executing || BookingStatus.confirmed => Colors.orange.shade800,
  _ => Colors.grey.shade600,
};

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.booking});
  final BookingView booking;
  @override
  Widget build(BuildContext context) {
    final r = booking.result;
    final plan = booking.confirmedPlan ?? booking.plan;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(booking.summary.isEmpty ? '正在整理訂位需求' : booking.summary, style: const TextStyle(fontWeight: FontWeight.w700)),
            if (plan != null) ...[const SizedBox(height: 8), Text('${plan.restaurant.name} · ${plan.date} ${plan.time} · ${plan.partySize} 位')],
            if (booking.status == BookingStatus.executing || booking.status == BookingStatus.confirmed) ...[
              const SizedBox(height: 8),
              const Row(
                children: [
                  SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  SizedBox(width: 8),
                  Text('瀏覽器正在操作訂位網站…'),
                ],
              ),
            ],
            if (r?.ok == true) ...[
              const SizedBox(height: 8),
              Text(
                '訂位成功，代號 ${r!.confirmationNo}',
                style: TextStyle(color: Colors.green.shade700, fontWeight: FontWeight.w700),
              ),
            ],
            if (r?.ok == false) ...[const SizedBox(height: 8), Text(r!.message ?? r.code ?? '沒有訂成', style: TextStyle(color: Colors.red.shade700))],
          ],
        ),
      ),
    );
  }
}

class _EventRow extends StatelessWidget {
  const _EventRow({required this.event});
  final BookingEvent event;
  @override
  Widget build(BuildContext context) {
    final user = event.type == 'user';
    final status = event.type == 'status';
    if (status)
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(
          child: Text(event.text, style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
        ),
      );
    return Align(
      alignment: user ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 540),
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: user ? const Color(0xFF6D4AFF) : Colors.white,
          borderRadius: BorderRadius.circular(14),
          border: user ? null : Border.all(color: const Color(0xFFE4E7EC)),
        ),
        child: Text(event.text, style: TextStyle(color: user ? Colors.white : null, height: 1.45)),
      ),
    );
  }
}

class _PendingCard extends StatelessWidget {
  const _PendingCard({required this.controller});
  final BookingController controller;
  @override
  Widget build(BuildContext context) {
    final p = controller.booking.pending!;
    return Card(
      margin: EdgeInsets.zero,
      color: const Color(0xFFFFFBFE),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: switch (p.kind) {
          'choose_restaurant' => _RestaurantChoices(controller: controller, items: p.restaurants),
          'choose_time' => _TimeChoices(controller: controller, times: p.times),
          'provide_slots' => _SlotsForm(controller: controller, fields: p.fields.map((f) => f.key).toList()),
          'provide_info' => _InfoForm(controller: controller, fields: p.fields),
          'confirm_plan' => _ConfirmPlan(controller: controller),
          _ => const Text('請直接在下方輸入餐廳名稱，或告訴我地區、料理、日期、時間與人數。'),
        },
      ),
    );
  }
}

class _RestaurantChoices extends StatelessWidget {
  const _RestaurantChoices({required this.controller, required this.items});
  final BookingController controller;
  final List<BookingRestaurant> items;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text('選擇餐廳', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      for (final r in items)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: OutlinedButton(
            onPressed: controller.busy ? null : () => controller.chooseRestaurant(r.id),
            style: OutlinedButton.styleFrom(alignment: Alignment.centerLeft, padding: const EdgeInsets.all(12)),
            child: Row(
              children: [
                const Icon(Icons.storefront_outlined),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(r.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                      Text(
                        [r.cuisine, r.district, r.address, r.rating == null ? null : '★ ${r.rating}'].whereType<String>().join(' · '),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right),
              ],
            ),
          ),
        ),
    ],
  );
}

class _TimeChoices extends StatelessWidget {
  const _TimeChoices({required this.controller, required this.times});
  final BookingController controller;
  final List<String> times;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text('選擇可訂時段', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final time in times) OutlinedButton(onPressed: controller.busy ? null : () => controller.chooseTime(time), child: Text(time)),
        ],
      ),
    ],
  );
}

class _SlotsForm extends StatefulWidget {
  const _SlotsForm({required this.controller, required this.fields});
  final BookingController controller;
  final List<String> fields;
  @override
  State<_SlotsForm> createState() => _SlotsFormState();
}

class _SlotsFormState extends State<_SlotsForm> {
  final date = TextEditingController();
  final time = TextEditingController();
  final party = TextEditingController();
  @override
  void dispose() {
    date.dispose();
    time.dispose();
    party.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text('補齊訂位條件', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      if (widget.fields.contains('date'))
        TextField(
          controller: date,
          decoration: const InputDecoration(labelText: '日期', hintText: 'YYYY-MM-DD'),
        ),
      if (widget.fields.contains('time'))
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: TextField(
            controller: time,
            decoration: const InputDecoration(labelText: '時間', hintText: 'HH:MM，例如 19:00'),
          ),
        ),
      if (widget.fields.contains('party_size'))
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: TextField(
            controller: party,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: '人數'),
          ),
        ),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: widget.controller.busy
            ? null
            : () => widget.controller.submitSlots(
                date: date.text.trim().isEmpty ? null : date.text.trim(),
                time: time.text.trim().isEmpty ? null : time.text.trim(),
                partySize: int.tryParse(party.text),
              ),
        child: const Text('繼續'),
      ),
    ],
  );
}

class _InfoForm extends StatefulWidget {
  const _InfoForm({required this.controller, required this.fields});
  final BookingController controller;
  final List<BookingInfoField> fields;
  @override
  State<_InfoForm> createState() => _InfoFormState();
}

class _InfoFormState extends State<_InfoForm> {
  final values = <String, TextEditingController>{};
  @override
  void initState() {
    super.initState();
    for (final f in widget.fields) {
      values[f.key] = TextEditingController();
    }
  }

  @override
  void dispose() {
    for (final c in values.values) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text('這家店需要以下資料', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      for (final f in widget.fields)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: f.type == 'select'
              ? DropdownButtonFormField<String>(
                  value: values[f.key]!.text.isEmpty ? null : values[f.key]!.text,
                  decoration: InputDecoration(labelText: f.label),
                  items: [for (final o in f.options) DropdownMenuItem(value: o, child: Text(o))],
                  onChanged: (v) => setState(() => values[f.key]!.text = v ?? ''),
                )
              : TextField(
                  controller: values[f.key],
                  keyboardType: f.type == 'email'
                      ? TextInputType.emailAddress
                      : f.type == 'tel'
                      ? TextInputType.phone
                      : TextInputType.text,
                  decoration: InputDecoration(labelText: f.label),
                ),
        ),
      FilledButton(
        onPressed: widget.controller.busy
            ? null
            : () {
                final contact = <String, String>{};
                final extra = <String, String>{};
                for (final f in widget.fields) {
                  final v = values[f.key]!.text.trim();
                  if (f.key.startsWith('contact.'))
                    contact[f.key.substring(8)] = v;
                  else if (f.key.startsWith('extra.'))
                    extra[f.key.substring(6)] = v;
                }
                widget.controller.submitSlots(contact: contact, extra: extra);
              },
        child: const Text('繼續'),
      ),
    ],
  );
}

class _ConfirmPlan extends StatelessWidget {
  const _ConfirmPlan({required this.controller});
  final BookingController controller;
  @override
  Widget build(BuildContext context) {
    final p = controller.booking.plan;
    if (p == null) return const SizedBox.shrink();
    final mins = p.expiresAt?.difference(DateTime.now()).inMinutes;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('請確認訂位方案', style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Text(
          '${p.restaurant.name}\n${p.restaurant.address}\n${p.date} ${p.time} · ${p.partySize} 位\n聯絡：${p.contact.values.join(' / ')}${p.extra.isEmpty ? '' : '\n${p.extra.entries.map((e) => '${e.key}：${e.value}').join('、')}'}${p.notes == null ? '' : '\n備註：${p.notes}'}',
          style: const TextStyle(height: 1.5),
        ),
        if (mins != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('方案約剩 ${mins < 0 ? 0 : mins} 分鐘有效', style: TextStyle(color: Colors.orange.shade800, fontSize: 12)),
          ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: controller.busy || !p.canConfirm ? null : controller.confirm,
          icon: const Icon(Icons.check),
          label: const Text('確認，開始訂位'),
        ),
      ],
    );
  }
}

class _Error extends StatelessWidget {
  const _Error({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    color: const Color(0xFFFEECEC),
    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
    child: Text(text, style: TextStyle(color: Colors.red.shade800)),
  );
}

class _Composer extends StatelessWidget {
  const _Composer({required this.controller, required this.busy, required this.onSend});
  final TextEditingController controller;
  final bool busy;
  final VoidCallback onSend;
  @override
  Widget build(BuildContext context) => Container(
    color: Colors.white,
    padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Focus(
            onKeyEvent: (_, event) {
              final enter = event.logicalKey == LogicalKeyboardKey.enter || event.logicalKey == LogicalKeyboardKey.numpadEnter;
              if (!enter || event is! KeyDownEvent || HardwareKeyboard.instance.isShiftPressed) return KeyEventResult.ignored;
              final composing = controller.value.composing;
              if (composing.isValid && !composing.isCollapsed) return KeyEventResult.ignored;
              if (!busy) onSend();
              return KeyEventResult.handled;
            },
            child: TextField(
              controller: controller,
              minLines: 1,
              maxLines: 4,
              enabled: !busy,
              decoration: InputDecoration(hintText: busy ? '正在處理訂位…' : '補充或修改條件，例如：改成晚上 8 點'),
            ),
          ),
        ),
        const SizedBox(width: 10),
        FilledButton(
          onPressed: busy ? null : onSend,
          style: FilledButton.styleFrom(minimumSize: const Size(52, 48)),
          child: const Icon(Icons.arrow_upward),
        ),
      ],
    ),
  );
}
