#!/usr/bin/env bash
# scripts/publish-subsite.sh
#
# 把某个私有项目构建出的公开静态产物镜像到本仓库（barryai.cn 的 GitHub Pages
# 公开镜像）的对应子目录，并提交 + 推送。
#
# 用法：
#   scripts/publish-subsite.sh <site-name> <source-dir>
#
#   site-name   只允许 briefs | openrouter
#   source-dir  源静态目录（例如 today-briefs/website/public）
#
# 环境变量：
#   PORTAL_REPO_DIR         覆盖 portal 仓库路径（默认取脚本自身所在仓库），便于测试
#   PUBLISH_DRY_RUN=1       只 rsync 并展示 diff，不 add/commit/push
#   PUBLISH_EXTRA_EXCLUDES  额外的 rsync 排除项，空白分隔（例如 "portal/"）
#   PUBLISH_LOCK_TIMEOUT    等待跨进程锁的秒数（默认 300）
#   PUBLISH_LOCK_STALE      锁被视为僵死的秒数（默认 900）
#
# 约定：
#   - portal 工作树必须初始 clean，否则拒绝执行（避免把别人的改动一起提交）
#   - 正式发布前先 git pull --ff-only
#   - rsync --delete，但永远排除 .DS_Store 与 .git
#   - 只 git add 本次的子目录
#   - 无变化时静默成功（不产生空提交，退出码 0）
#
# 所有进度日志走 stderr；stdout 只在有实际变更时输出一行提交信息，
# 方便调用方用 `if [ -n "$(publish-subsite.sh ...)" ]` 判断是否发生了发布。

set -euo pipefail

# ── 从脚本自身位置确定 portal repo，不依赖 cwd ────────────────────
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"
DEFAULT_PORTAL_REPO="$( cd "$SCRIPT_DIR/.." && pwd -P )"
PORTAL_REPO="${PORTAL_REPO_DIR:-$DEFAULT_PORTAL_REPO}"

DRY_RUN="${PUBLISH_DRY_RUN:-0}"
LOCK_TIMEOUT="${PUBLISH_LOCK_TIMEOUT:-300}"
LOCK_STALE="${PUBLISH_LOCK_STALE:-900}"

log()  { printf '%s\n' "$*" >&2; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" >&2
  exit 2
}

# ── 参数校验 ──────────────────────────────────────────────────────
[ "$#" -eq 2 ] || usage

SITE="$1"
SOURCE_DIR="$2"

case "$SITE" in
  briefs|openrouter) ;;
  *) die "不支持的 site-name: '$SITE'（只允许 briefs | openrouter）" ;;
esac

[ -d "$SOURCE_DIR" ] || die "source-dir 不存在或不是目录: $SOURCE_DIR"
SOURCE_DIR="$( cd "$SOURCE_DIR" && pwd -P )"

[ -d "$PORTAL_REPO/.git" ] || die "portal 仓库不是 git 工作树: $PORTAL_REPO"
PORTAL_REPO="$( cd "$PORTAL_REPO" && pwd -P )"

command -v rsync >/dev/null 2>&1 || die "缺少 rsync"

DEST_DIR="$PORTAL_REPO/$SITE"

# 防止把 portal 自己 rsync 进自己的子目录
case "$SOURCE_DIR/" in
  "$PORTAL_REPO"/*) die "source-dir 不能位于 portal 仓库内部: $SOURCE_DIR" ;;
esac

# ── 跨进程锁 ──────────────────────────────────────────────────────
# 锁放在 .git/ 里：与仓库绑定、不会被 git status 看见、也不会被 rsync --delete 波及。
LOCK_DIR="$PORTAL_REPO/.git/publish-subsite.lock"
LOCK_HELD=0

release_lock() {
  if [ "$LOCK_HELD" = "1" ]; then
    LOCK_HELD=0
    rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
}
# 进程无论怎么退出（正常 / set -e 失败 / Ctrl-C / kill），锁都会被释放
trap release_lock EXIT
trap 'release_lock; exit 130' INT
trap 'release_lock; exit 143' TERM HUP

lock_age_seconds() {
  local now mtime
  now="$(date +%s)"
  # BSD (macOS) 与 GNU stat 的参数不同，两个都试
  mtime="$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo "$now")"
  echo $(( now - mtime ))
}

# 僵死锁判定：持有者进程已不存在，或锁存在时间超过 PUBLISH_LOCK_STALE。
# 后者兜底 pid 复用 / pid 文件还没写出来就被 kill 的情况，保证不会永久死锁。
lock_is_stale() {
  local owner
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    return 0
  fi
  [ "$(lock_age_seconds)" -gt "$LOCK_STALE" ]
}

acquire_lock() {
  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if lock_is_stale; then
      log "  ⚠️ 发现僵死锁（${LOCK_DIR}），清理后重试"
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    if [ "$waited" -ge "$LOCK_TIMEOUT" ]; then
      die "等待 portal 发布锁超时（${LOCK_TIMEOUT}s）：$LOCK_DIR"
    fi
    [ "$waited" = 0 ] && log "  · 另一个发布任务正在占用 portal，等待中 …"
    sleep 1
    waited=$(( waited + 1 ))
  done
  LOCK_HELD=1
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

acquire_lock

# ── 前置检查：工作树必须 clean ─────────────────────────────────────
cd "$PORTAL_REPO"

if [ -n "$(git status --porcelain)" ]; then
  log "$(git status --short)"
  die "portal 工作树不 clean（${PORTAL_REPO}），先处理完再发布"
fi

# ── 同步前先对齐远端 ──────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  log "▸ [dry-run] 跳过 git pull（dry-run 不做任何网络与历史操作）"
elif git remote get-url origin >/dev/null 2>&1; then
  log "▸ git pull --ff-only origin"
  # git pull 的进度信息走 stdout，统一转到 stderr，保证「无变化」时 stdout 为空
  git pull --ff-only >&2
else
  log "  ⚠️ 未配置 origin remote，跳过 git pull"
fi

# ── rsync 镜像 ────────────────────────────────────────────────────
mkdir -p "$DEST_DIR"

RSYNC_ARGS=(-a --delete --exclude '.DS_Store' --exclude '.git' --exclude '.git/')
if [ -n "${PUBLISH_EXTRA_EXCLUDES:-}" ]; then
  # shellcheck disable=SC2086
  for pat in ${PUBLISH_EXTRA_EXCLUDES}; do
    RSYNC_ARGS+=(--exclude "$pat")
  done
fi

log "▸ rsync $SOURCE_DIR/ → $DEST_DIR/"
rsync "${RSYNC_ARGS[@]}" "$SOURCE_DIR/" "$DEST_DIR/"

# ── dry-run：只展示 diff ──────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  log "▸ [dry-run] 变更预览（不 add / commit / push）"
  git --no-pager diff --stat -- "$SITE" >&2 || true
  git --no-pager status --short -- "$SITE" >&2 || true
  if [ -z "$(git status --porcelain -- "$SITE")" ]; then
    log "  · 无变化"
  else
    log ""
    log "  ⚠️ dry-run 已把文件写入工作树。还原命令："
    log "     git -C '$PORTAL_REPO' checkout -- '$SITE' && git -C '$PORTAL_REPO' clean -fd -- '$SITE'"
  fi
  exit 0
fi

# ── 只 add 本次的子目录 ───────────────────────────────────────────
git add -A -- "$SITE"

if git diff --cached --quiet -- "$SITE"; then
  log "  · $SITE 无变化，跳过提交"
  exit 0
fi

COMMIT_MSG="content($SITE): publish static site"
git commit -q -m "$COMMIT_MSG" -- "$SITE"
log "▸ 已提交：$COMMIT_MSG"

if git remote get-url origin >/dev/null 2>&1; then
  log "▸ git push"
  git push -q
else
  log "  ⚠️ 未配置 origin remote，跳过 git push"
fi

printf '%s %s\n' "$(git rev-parse --short HEAD)" "$COMMIT_MSG"
