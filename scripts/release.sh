#!/usr/bin/env bash
# 版本化部署與 rollback(docker compose)。細節與限制見 docs/OPERATIONS.md。
#
#   scripts/release.sh deploy   [--scale] [--tag T] [--force] [--no-backup] [--no-probe] [--smoke] [--allow-dirty]
#   scripts/release.sh rollback [TAG]
#   scripts/release.sh status
#   scripts/release.sh migrate status [服務]
#   scripts/release.sh migrate down <服務> [--steps N] [--version TAG] --yes   倒退 migration(先 rollback 程式,再執行這個)
#   scripts/release.sh compose <docker compose 的參數…>     以「目前版本」的設定執行 docker compose(例如調整 replica 數)
#   scripts/release.sh budget
#   scripts/release.sh prune [N]
#
# 做法:
#   - 每個版本的 image 用 git commit 當 tag(chat-app/backend:<sha>),舊版本留在本機 → rollback 不需要重新 build,幾十秒內完成。
#   - 一個服務一個服務滾動更新:先啟動新版、確認 healthy,再停掉舊版。有多個 replica 時整個過程不中斷。
#   - 部署前:備份資料庫、確認沒有進行中的訂位、檢查 PostgreSQL 連線數預算。
#   - 部署後:確認所有容器 healthy 且沒有重啟,再用一個暫時帳號走一遍主要流程。失敗時只報告,是否 rollback 由人決定(不會自動退回)。
#
# 注意:rollback 只換程式,不會回復資料庫。要倒退 migration 請在 rollback 之後用 `migrate down`。見 docs/OPERATIONS.md §3。
#
# 可用環境變數:
#   COMPOSE_FILE / COMPOSE_PROJECT_NAME   同 docker compose(一般不需要設定;--scale 會自動記住)
#   RELEASE_STATE_DIR (預設 .deploy)  RELEASE_BACKUP_DIR (預設 .db-backup)  RELEASE_URL (探測用入口,預設 http://localhost:8080)
#   WATCH_SEC (部署後觀察秒數,預設 15)  IDLE_WAIT_SEC (等進行中訂位結束的上限,預設 60)  KEEP_IMAGES (保留幾個版本,預設 5)
#   SETTLE_SEC (停掉每個舊 replica 之間等 DNS 傳播的秒數,預設 3)
set -euo pipefail

cd "$(dirname "$0")/.."

STATE_DIR="${RELEASE_STATE_DIR:-.deploy}"
BACKUP_DIR="${RELEASE_BACKUP_DIR:-.db-backup}"
WATCH_SEC="${WATCH_SEC:-15}"
IDLE_WAIT_SEC="${IDLE_WAIT_SEC:-60}"
KEEP_IMAGES="${KEEP_IMAGES:-5}"
SETTLE_SEC="${SETTLE_SEC:-3}"
BACKEND_IMAGE="chat-app/backend"
AGENT_IMAGE="chat-app/browser-agent"
# 滾動更新的順序:被依賴的先更新,gateway 最後
ROLL_ORDER="browser-agent billing character auth chat booking gateway admin"

mkdir -p "$STATE_DIR"

log()  { printf '\033[1;34m[release]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[release]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[release]\033[0m %s\n' "$*" >&2; exit 1; }
read_state() { [ -f "$STATE_DIR/$1" ] && cat "$STATE_DIR/$1" || true; }
write_state() { printf '%s\n' "$2" > "$STATE_DIR/$1"; }
history() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$STATE_DIR/history.log"; }
dc() { docker compose "$@"; }

# 部署模式(單機 / 多 replica)要在 deploy 與之後的 rollback 之間保持一致,所以記下來
load_mode() {
  if [ -z "${COMPOSE_FILE:-}" ] && [ -f "$STATE_DIR/compose_file" ]; then
    COMPOSE_FILE="$(cat "$STATE_DIR/compose_file")"
    export COMPOSE_FILE
  fi
}

# ------------------------------------------------------------------ 服務資訊
# 輸出每行:<service> <replicas> <有對外開埠 0/1>
service_info() {
  dc config --format json | python3 -c '
import json, sys
d = json.load(sys.stdin)
for name, s in sorted(d["services"].items()):
    if s.get("profiles"):
        continue
    print(name, (s.get("deploy") or {}).get("replicas", 1), 1 if s.get("ports") else 0)
'
}

# ------------------------------------------------------------------ PostgreSQL 連線數預算
cmd_budget() {
  load_mode
  # 以「執行中的 PostgreSQL」為準:設定檔改了 max_connections,資料庫沒重啟就不會生效(deploy 刻意不重建資料庫)
  local live; live="$(dc exec -T postgres psql -U chatapp -d postgres -tAc 'SHOW max_connections' 2>/dev/null | tr -d '[:space:]')" || true
  dc config --format json | LIVE_MAXC="${live:-}" python3 -c '
import json, re, sys
d = json.load(sys.stdin)
RESERVE = 20   # superuser 保留 + migration / 維運用連線
maxc = 100
for tok in d["services"].get("postgres", {}).get("command", []):
    m = re.match(r"max_connections=(\d+)", str(tok))
    if m: maxc = int(m.group(1))
import os
conf_maxc = maxc
live = os.environ.get("LIVE_MAXC", "")
if live.isdigit():
    maxc = int(live)
rows = []
for name, s in sorted(d["services"].items()):
    env = s.get("environment") or {}
    if "DATABASE_URL" not in env or s.get("profiles"): continue
    pool = int(env.get("PG_POOL_MAX") or 10)
    rep = int((s.get("deploy") or {}).get("replicas", 1))
    rows.append((name, rep, pool, rep * pool))
total = sum(r[3] for r in rows)
# 滾動更新時,同一個服務會暫時多出一倍的 replica
surge = max((r[3] for r in rows), default=0)
print("%-12s %8s %10s %8s" % ("服務", "replica", "pool/個", "最多連線"))
for n, rep, pool, sub in rows:
    print("%-12s %8d %10d %8d" % (n, rep, pool, sub))
print("-" * 42)
print("%-12s %28d" % ("合計", total))
print("%-12s %28d  (滾動更新時最大那個服務暫時加倍)" % ("更新時尖峰", total + surge))
print("%-12s %28d  (max_connections %d − 保留 %d)" % ("可用上限", maxc - RESERVE, maxc, RESERVE))
if total + surge > maxc - RESERVE:
    print("\n超出預算。調低各服務的 *_PG_POOL_MAX、減少 replica,或調高 PG_MAX_CONNECTIONS(要重啟 PostgreSQL)/ 加 PgBouncer。")
    sys.exit(1)
if maxc != conf_maxc:
    print("\n注意:設定檔寫的 max_connections 是 %d,但執行中的 PostgreSQL 是 %d(以執行中的為準)。" % (conf_maxc, maxc))
    print("要套用設定檔的值必須重啟 PostgreSQL(會短暫中斷所有服務),見 docs/OPERATIONS.md §4「第一次從單機切換」。")
print("\n在預算內。")
'
}

# ------------------------------------------------------------------ 前置檢查
active_bookings() {
  local n
  n="$(dc exec -T postgres psql -U chatapp -d booking -tAc \
    "SELECT count(*) FROM bookings WHERE status IN ('confirmed','executing')" 2>/dev/null | tr -d '[:space:]')" || true
  echo "${n:-0}"
}

wait_idle_bookings() {
  local n waited=0
  n="$(active_bookings)"
  while [ "$n" != "0" ] && [ "$waited" -lt "$IDLE_WAIT_SEC" ]; do
    log "有 $n 筆訂位正在執行(更新 booking / browser-agent 會讓它們變成「結果不明」),等待中… (${waited}s/${IDLE_WAIT_SEC}s)"
    sleep 5; waited=$((waited + 5)); n="$(active_bookings)"
  done
  if [ "$n" != "0" ]; then
    [ "${FORCE:-0}" = "1" ] && { warn "仍有 $n 筆訂位在執行,--force 繼續。這些訂位會變成「結果不明」(不扣點,需人工向店家確認)。"; return 0; }
    die "仍有 $n 筆訂位在執行,中止(尚未做任何變更)。等它們結束,或加 --force。"
  fi
}

backup_db() {
  mkdir -p "$BACKUP_DIR"
  local f="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)-$1.sql.gz"
  if ! dc exec -T postgres pg_dumpall -U chatapp 2>/dev/null | gzip > "$f"; then
    rm -f "$f"; die "資料庫備份失敗,中止。(確定要略過備份時加 --no-backup)"
  fi
  [ -s "$f" ] || { rm -f "$f"; die "備份檔是空的,中止。"; }
  chmod 600 "$f"   # 含個資
  # 只保留最近 KEEP_IMAGES 份
  ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +$((KEEP_IMAGES + 1)) | while read -r old; do rm -f "$old"; done
  log "資料庫已備份:$f ($(du -h "$f" | cut -f1))"
  echo "$f"
}

# ------------------------------------------------------------------ 滾動更新
# 沒有對外開埠的服務:先多開一組新版 → 等 healthy → 停掉舊版。有開埠的(單機模式的 gateway、admin)無法同時兩份,原地重建。
roll_service() {
  local svc="$1" replicas="$2" published="$3" old n_old id
  old="$(dc ps -q "$svc" 2>/dev/null | tr '\n' ' ')"
  n_old="$(echo "$old" | wc -w | tr -d ' ')"

  if [ "$n_old" = "0" ] || [ "$published" = "1" ]; then
    if [ "$published" = "1" ] && [ "$n_old" != "0" ]; then
      warn "${svc} 對外開了埠,無法同時跑兩份 → 原地重建(約幾秒的中斷)。要不中斷請用 --scale。"
    fi
    log "更新 ${svc}(原地)"
    dc up -d --no-deps --wait --wait-timeout 180 "$svc" >&2 || { warn "${svc} 啟動失敗"; return 1; }
    return 0
  fi

  log "更新 ${svc}:${n_old} 個舊 replica → 先啟動 ${replicas} 個新的"
  # 注意:set -e 在 `if f` / `f || g` 內呼叫的函式裡不生效,所以每個可能失敗的指令都要明確處理
  if ! dc up -d --no-deps --no-recreate --scale "$svc=$((n_old + replicas))" --wait --wait-timeout 180 "$svc" >&2; then
    warn "${svc} 新版沒有變成 healthy,移除剛啟動的容器,舊版繼續服務。"
    for id in $(dc ps -aq "$svc"); do
      case " $old " in *" $id "*) ;; *) docker rm -f "$id" >/dev/null 2>&1 || true ;; esac
    done
    return 1
  fi
  log "  新版 healthy,停掉舊的 ${svc}(等進行中的請求收尾,最多 35 秒)"
  # 一次停一個,中間等 DNS 傳播:呼叫端(nginx、gateway、ServiceClient)最多 2 秒才會更新 replica 名單,
  # 若同時停掉全部舊 replica,名單還沒更新的呼叫端會在這個空窗裡找不到任何可用的目標。
  local first=1 c
  for c in $old; do
    [ "$first" = "1" ] || sleep "$SETTLE_SEC"
    first=0
    docker stop "$c" >/dev/null || warn "停止舊的 ${svc} 時出錯"
    docker rm "$c" >/dev/null 2>&1 || true
  done
  dc up -d --no-deps --scale "$svc=$replicas" "$svc" >/dev/null 2>&1 || return 1
}

roll_all() {
  local info svc line rep pub
  info="$(service_info)"
  for svc in $ROLL_ORDER; do
    line="$(echo "$info" | awk -v s="$svc" '$1==s')"
    [ -z "$line" ] && continue
    rep="$(echo "$line" | awk '{print $2}')"; pub="$(echo "$line" | awk '{print $3}')"
    roll_service "$svc" "$rep" "$pub" || return 1
  done
  # 前端入口(nginx):設定有變才會重建
  if echo "$info" | awk '$1=="edge"{f=1} END{exit !f}'; then
    dc up -d --no-deps --wait edge >/dev/null || return 1
  fi
}

# ------------------------------------------------------------------ 驗證
check_containers() {
  local bad svc rep pub running rc=0
  bad="$(dc ps -a --format '{{.Service}} {{.State}} {{.Health}}' | awk '$2!="running" || ($3!="" && $3!="healthy") {print}')"
  if [ -n "$bad" ]; then warn "以下容器不正常:"; echo "$bad" >&2; rc=1; fi
  while read -r svc rep pub; do
    running="$(dc ps --status running -q "$svc" | wc -l | tr -d ' ')"
    if [ "$running" -lt "$rep" ]; then warn "${svc} 預期 ${rep} 個 replica,只有 ${running} 個在執行"; rc=1; fi
  done < <(service_info)
  return $rc
}

# 部署後出現重啟 = crash loop
check_no_restarts() {
  local id n bad=0
  for id in $(dc ps -q); do
    n="$(docker inspect -f '{{.RestartCount}}' "$id")"
    if [ "$n" -gt 0 ]; then warn "$(docker inspect -f '{{.Name}}' "$id") 重啟了 $n 次"; bad=1; fi
  done
  return $bad
}

# 用一個暫時帳號走一遍:註冊 → 角色 → 點數 → 刪除帳號。經過 gateway、auth、character、billing、Redis、PostgreSQL。
probe() {
  local url="${RELEASE_URL:-http://localhost:8080}" name="relprobe$(date +%s)$RANDOM" r token
  r="$(curl -fsS -m 10 -X POST "$url/v1/auth/register" -H 'content-type: application/json' \
      -d "{\"username\":\"$name\",\"password\":\"probe-pass-123\",\"device_id\":\"release\",\"device_name\":\"release\"}")" || { warn "探測:註冊失敗"; return 1; }
  token="$(echo "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')" || return 1
  local ok=0
  curl -fsS -m 10 "$url/v1/characters" -H "authorization: Bearer $token" | grep -q '"items"' || { warn "探測:取得角色失敗"; ok=1; }
  curl -fsS -m 10 "$url/v1/points/balance" -H "authorization: Bearer $token" | grep -q 'balance' || { warn "探測:取得點數失敗"; ok=1; }
  curl -fsS -m 10 -X DELETE "$url/v1/me" -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d '{"password":"probe-pass-123"}' >/dev/null || warn "探測:暫時帳號 $name 沒刪成功,請手動刪除"
  return $ok
}

verify() {
  log "驗證:所有容器 healthy…"
  check_containers || return 1
  log "驗證:觀察 ${WATCH_SEC} 秒,看有沒有重啟…"
  sleep "$WATCH_SEC"
  check_containers && check_no_restarts || return 1
  if [ "${NO_PROBE:-0}" != "1" ]; then
    log "驗證:暫時帳號走一遍主要流程…"
    probe || return 1
  fi
  if [ "${SMOKE:-0}" = "1" ]; then
    log "驗證:聊天冒煙測試(假設使用 mock 模型,見 docs/OPERATIONS.md)…"
    dc --profile tools run --rm --no-deps tools bun scripts/smoke.ts || return 1
  fi
}

# 執行中的容器使用的 image 版本,和紀錄的「目前版本」不同 → 有人直接用 docker compose 改過
drift() {
  local cur; cur="$(read_state current)"
  [ -n "$cur" ] || return 0
  dc ps --format '{{.Service}} {{.Image}}' | awk -v want="$cur" '
    $2 ~ /^chat-app\/(backend|browser-agent):/ { split($2, a, ":"); if (a[2] != want) print "  " $1 " 使用 " $2 }'
}

images_present() {
  docker image inspect "$BACKEND_IMAGE:$1" >/dev/null 2>&1 && docker image inspect "$AGENT_IMAGE:$1" >/dev/null 2>&1
}

# ------------------------------------------------------------------ 指令
cmd_deploy() {
  local tag="" backup=1
  FORCE=0; NO_PROBE=0; SMOKE=0; local allow_dirty=0 scale=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --tag) tag="$2"; shift ;;
      --force) FORCE=1 ;;
      --no-backup) backup=0 ;;
      --no-probe) NO_PROBE=1 ;;
      --smoke) SMOKE=1 ;;
      --allow-dirty) allow_dirty=1 ;;
      --scale) scale=1 ;;
      *) die "未知的參數:$1" ;;
    esac
    shift
  done
  # 已經自己設了 COMPOSE_FILE 就照它(例如另外加了自己的覆蓋檔);否則 --scale 用多 replica 的預設組合
  if [ "$scale" = "1" ] && [ -z "${COMPOSE_FILE:-}" ]; then COMPOSE_FILE="docker-compose.yml:docker-compose.scale.yml"; export COMPOSE_FILE
  else load_mode; fi

  if [ -z "$tag" ]; then
    tag="$(git rev-parse --short=12 HEAD)"
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
      [ "$allow_dirty" = "1" ] || die "工作目錄有未 commit 的修改,這樣的版本無法重現。先 commit,或加 --allow-dirty。"
      tag="$tag-dirty-$(date +%Y%m%d%H%M%S)"
      warn "未 commit 的修改也會進這個版本($tag)"
    fi
  fi
  export IMAGE_TAG="$tag"
  local prev; prev="$(read_state current)"
  [ "$prev" = "$tag" ] && warn "目前就是 ${tag},重新部署一次。"
  if [ -n "$(drift)" ]; then warn "執行中的版本和紀錄的目前版本不一致,rollback 的「上一版」可能不是你預期的:"; drift >&2; fi

  log "部署版本 $tag(上一版:${prev:-無})  模式:${COMPOSE_FILE:-單機}"
  mkdir "$STATE_DIR/lock" 2>/dev/null || die "另一個部署正在進行(或上次異常中止)。確認後刪除 $STATE_DIR/lock。"
  trap 'rmdir "$STATE_DIR/lock" 2>/dev/null || true' EXIT

  cmd_budget >/dev/null || { cmd_budget || true; die "PostgreSQL 連線數預算不足,中止(尚未做任何變更)。"; }

  dc up -d --no-recreate --wait postgres redis-state redis-cache >/dev/null   # 基礎設施:沒起來才啟動,絕不重建
  wait_idle_bookings
  local bk=""
  if [ "$backup" = "1" ]; then bk="$(backup_db "$tag")" || die "備份失敗,中止(尚未更新任何服務)。"; fi

  log "建置 image ${tag}…"
  dc build gateway browser-agent

  history "deploy $tag start (prev=${prev:-none} backup=${bk:-none})"
  if roll_all && verify; then
    [ -n "$prev" ] && [ "$prev" != "$tag" ] && write_state previous "$prev"
    write_state current "$tag"
    [ -n "${COMPOSE_FILE:-}" ] && write_state compose_file "$COMPOSE_FILE"
    [ -n "$bk" ] && write_state last_backup "$bk"
    history "deploy $tag ok"
    log "完成:${tag}。出問題時:scripts/release.sh rollback"
    cmd_prune "$KEEP_IMAGES" || true
    return 0
  fi

  history "deploy ${tag} FAILED"
  warn "部署 ${tag} 失敗(服務可能處於新舊版本混合的狀態)。"
  warn "查原因:docker compose logs --since 10m <服務>"
  if [ -n "$prev" ] && [ "$prev" != "$tag" ]; then
    warn "要退回上一版:scripts/release.sh rollback   (上一版 ${prev})"
  fi
  [ -n "$bk" ] && warn "部署前的資料庫備份:${bk}"
  exit 1
}

cmd_rollback() {
  load_mode
  FORCE=1; NO_PROBE=0; SMOKE=0
  local cur target="${1:-}" mixed; cur="$(read_state current)"; mixed="$(drift)"
  if [ -z "$target" ]; then
    # 部署失敗後,執行中的版本和紀錄的「目前版本」不同:退回的是紀錄中最後一個成功的版本,不是再上一版
    if [ -n "$mixed" ]; then target="$cur"; else target="$(read_state previous)"; fi
  fi
  [ -n "$target" ] || die "沒有上一版的紀錄。用 scripts/release.sh rollback <tag>,tag 可從 `status` 查。"
  if [ "$target" = "$cur" ] && [ -z "$mixed" ]; then die "目前已經是 ${target}。"; fi
  images_present "$target" || die "找不到版本 $target 的 image(可能已被 prune)。改用:git checkout <commit> && scripts/release.sh deploy"

  if [ "$cur" = "$target" ]; then log "rollback:修正成紀錄的版本 ${target}(不重新 build)"
  else log "rollback:${cur:-?} → ${target}(不重新 build)"; fi
  local n; n="$(active_bookings)"
  [ "$n" != "0" ] && warn "有 $n 筆訂位在執行,更新 booking 會讓它們變成「結果不明」(不扣點)。"
  export IMAGE_TAG="$target"
  mkdir "$STATE_DIR/lock" 2>/dev/null || die "另一個部署正在進行。確認後刪除 $STATE_DIR/lock。"
  trap 'rmdir "$STATE_DIR/lock" 2>/dev/null || true' EXIT
  history "rollback ${cur:-?} -> $target start"
  if roll_all && verify; then
    if [ -n "$cur" ] && [ "$cur" != "$target" ]; then write_state previous "$cur"; fi
    write_state current "$target"
    history "rollback to $target ok"
    log "完成。目前版本:$target"
    warn "資料庫沒有被回復。若新版有跑過 migration,請確認舊版程式相容(docs/OPERATIONS.md)。上次部署前的備份:$(read_state last_backup)"
  else
    history "rollback to $target FAILED"
    die "rollback 後驗證失敗,需要人工處理。"
  fi
}

cmd_status() {
  load_mode
  echo "目前版本:   $(read_state current)"
  echo "上一版:     $(read_state previous)"
  echo "部署模式:   ${COMPOSE_FILE:-單機 (docker-compose.yml)}"
  echo "最近備份:   $(read_state last_backup)"
  local d; d="$(drift)"
  if [ -n "$d" ]; then
    echo; warn "執行中的版本和紀錄的目前版本不一致(是不是直接執行了 docker compose up?):"; echo "$d" >&2
    echo "  修正:scripts/release.sh rollback $(read_state current)  或重新 deploy" >&2
  fi
  echo; echo "本機保留的版本(新→舊):"
  docker images "$BACKEND_IMAGE" --format '  {{.Tag}}  {{.CreatedSince}}  {{.Size}}' | grep -v ' local ' || true
  echo; echo "執行中的容器使用的 image:"
  dc ps --format '  {{.Service}}  {{.Image}}  {{.Health}}' | sort
  echo; echo "最近的紀錄:"; tail -n 8 "$STATE_DIR/history.log" 2>/dev/null | sed 's/^/  /' || true
}

cmd_prune() {
  local keep="${1:-$KEEP_IMAGES}" cur prev
  cur="$(read_state current)"; prev="$(read_state previous)"
  docker images "$BACKEND_IMAGE" --format '{{.Tag}}' | grep -v '^local$' | grep -v '<none>' | tail -n +$((keep + 1)) | while read -r t; do
    [ "$t" = "$cur" ] || [ "$t" = "$prev" ] || { docker rmi "$BACKEND_IMAGE:$t" >/dev/null 2>&1 || true; docker rmi "$AGENT_IMAGE:$t" >/dev/null 2>&1 || true; log "清除舊版本 image:$t"; }
  done
}

# 倒退 migration。順序很重要:服務啟動時會自動套用「該版本程式裡有的」migration,
# 所以必須先把程式退回到沒有這個 migration 的版本(rollback),否則服務一重啟就又套回去。
# down 的 SQL 只存在於「有這個 migration 的版本」,所以用那個版本的 image 來執行(預設 = rollback 之前的版本 = previous)。
cmd_migrate() {
  load_mode
  local sub="${1:-}"; shift || true
  local cur prev tag
  cur="$(read_state current)"; prev="$(read_state previous)"
  case "$sub" in
    status)
      tag="${cur:-local}"
      IMAGE_TAG="$tag" dc --profile tools run --rm --no-deps tools bun scripts/migrate.ts status "$@"
      ;;
    down)
      [ $# -ge 1 ] || die "用法:migrate down <服務> [--steps N] [--version TAG] --yes"
      tag="$prev"
      local args=() yes=0; while [ $# -gt 0 ]; do
        case "$1" in --version) tag="$2"; shift ;; --yes) yes=1 ;; *) args+=("$1") ;; esac; shift
      done
      [ -n "$tag" ] || die "不知道要用哪個版本的 image 來倒退。用 --version <含有該 migration 的版本>(版本名見 status)。"
      images_present "$tag" || die "找不到版本 ${tag} 的 image,無法取得它的 down。"
      if [ "$tag" = "$cur" ]; then
        die "目前執行中的程式就是 ${tag}(含有這個 migration)。先 rollback 程式,再倒退 migration,否則服務一重啟就會又套回去。"
      fi
      if [ -n "$(drift)" ]; then die "執行中的版本和紀錄不一致,先 rollback 讓版本一致再倒退。"; fi
      warn "將用版本 ${tag} 的 image 倒退 migration(目前程式版本:${cur})。這可能弄丟資料(例如被移除欄位裡的內容)。"
      warn "上次部署前的備份:$(read_state last_backup)"
      [ "$yes" = "1" ] || die "確認要執行請加 --yes。"
      IMAGE_TAG="$tag" dc --profile tools run --rm --no-deps -e ALLOW_MIGRATE_DOWN=1 tools bun scripts/migrate.ts down "${args[@]}"
      history "migrate down ${args[*]} (image ${tag})"
      ;;
    *) die "用法:migrate status [服務] | migrate down <服務> [--steps N] [--version TAG] --yes" ;;
  esac
}

cmd_compose() {
  load_mode
  local cur; cur="$(read_state current)"
  [ -n "$cur" ] && export IMAGE_TAG="$cur"
  exec docker compose "$@"
}

case "${1:-}" in
  deploy)   shift; cmd_deploy "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  status)   cmd_status ;;
  compose)  shift; cmd_compose "$@" ;;
  migrate)  shift; cmd_migrate "$@" ;;
  budget)   cmd_budget ;;
  prune)    shift; cmd_prune "$@" ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
