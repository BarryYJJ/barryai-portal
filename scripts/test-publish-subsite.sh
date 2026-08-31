#!/usr/bin/env bash
# scripts/test-publish-subsite.sh
#
# publish-subsite.sh 的自包含测试：在 /tmp 里造一个 bare remote + clone，
# 全程不碰真实的 barryai-portal 仓库，也不会推送到 GitHub。
#
# 用法：bash scripts/test-publish-subsite.sh

set -uo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"
HELPER="$SCRIPT_DIR/publish-subsite.sh"

PASS=0
FAIL=0

ok()   { printf '  ✓ %s\n' "$1"; PASS=$(( PASS + 1 )); }
bad()  { printf '  ✗ %s\n' "$1"; FAIL=$(( FAIL + 1 )); }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2${3:+ — $3}"; fi; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/publish-subsite-test.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

REMOTE="$TMP/remote.git"
PORTAL="$TMP/portal"
SRC="$TMP/src"
AINEWS_SRC="$TMP/src-ai-news"

setup_repo() {
  rm -rf "$REMOTE" "$PORTAL"
  git init -q --bare "$REMOTE"
  git init -q "$PORTAL"
  git -C "$PORTAL" config user.email "test@example.invalid"
  git -C "$PORTAL" config user.name  "publish-subsite test"
  git -C "$PORTAL" config commit.gpgsign false
  : > "$PORTAL/.nojekyll"
  echo "barryai.cn" > "$PORTAL/CNAME"
  echo "<html>portal</html>" > "$PORTAL/index.html"
  git -C "$PORTAL" add -A
  git -C "$PORTAL" commit -q -m "init"
  git -C "$PORTAL" branch -M main
  git -C "$PORTAL" remote add origin "$REMOTE"
  git -C "$PORTAL" push -q -u origin main
}

setup_ainews_src() {
  rm -rf "$AINEWS_SRC"
  mkdir -p "$AINEWS_SRC/assets" "$AINEWS_SRC/data"
  echo "<html>ai-news</html>"                > "$AINEWS_SRC/index.html"
  echo "body{}"                              > "$AINEWS_SRC/assets/app.css"
  echo '{"schema_version":1,"briefs":[]}'    > "$AINEWS_SRC/data/news.json"
}

setup_src() {
  rm -rf "$SRC"
  mkdir -p "$SRC/js" "$SRC/briefs" "$SRC/portal"
  echo "<html>site</html>"        > "$SRC/index.html"
  echo "console.log(1)"           > "$SRC/js/app.js"
  echo "<html>brief</html>"       > "$SRC/briefs/2026-08-31-morning.html"
  echo "<html>portal src</html>"  > "$SRC/portal/index.html"
  printf '\x00junk'               > "$SRC/.DS_Store"
}

remote_head() { git -C "$REMOTE" rev-parse HEAD 2>/dev/null || echo none; }
local_head()  { git -C "$PORTAL" rev-parse HEAD; }

echo "publish-subsite.sh 测试"
echo ""

# ── 1. 参数与 site 白名单 ─────────────────────────────────────────
echo "[1] 参数校验"
setup_repo; setup_src

out="$(PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" evil-site "$SRC" 2>&1)"; rc=$?
[ "$rc" -ne 0 ]; check $? "拒绝非法 site-name（evil-site）"
case "$out" in *"不支持的 site-name"*) ok "非法 site 的报错信息可读";; *) bad "非法 site 的报错信息可读 — 实际: $out";; esac

for bad_site in ".." "../../etc" "briefs/../.." "" "BRIEFS"; do
  PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" "$bad_site" "$SRC" >/dev/null 2>&1
  [ $? -ne 0 ]; check $? "拒绝 site-name '$bad_site'"
done

for good_site in briefs openrouter ai-news; do
  PORTAL_REPO_DIR="$PORTAL" PUBLISH_DRY_RUN=1 bash "$HELPER" "$good_site" "$SRC" >/dev/null 2>&1
  check $? "接受白名单 site-name '$good_site'"
  git -C "$PORTAL" checkout -- . 2>/dev/null; git -C "$PORTAL" clean -qfd
done

for near_miss in "ai_news" "ainews" "AI-NEWS" "ai-news/"; do
  PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" "$near_miss" "$SRC" >/dev/null 2>&1
  [ $? -ne 0 ]; check $? "拒绝形近 site-name '$near_miss'"
done

PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs >/dev/null 2>&1
[ $? -ne 0 ]; check $? "参数个数不对时退出非 0"

PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$TMP/does-not-exist" >/dev/null 2>&1
[ $? -ne 0 ]; check $? "拒绝不存在的 source-dir"

[ -z "$(git -C "$PORTAL" status --porcelain)" ]; check $? "校验失败后没有污染工作树"
[ "$(remote_head)" = "$(local_head)" ]; check $? "校验失败后没有 push"

# ── 2. 不依赖 cwd ────────────────────────────────────────────────
echo ""
echo "[2] 仓库定位"
setup_repo; setup_src
( cd / && PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1 )
check $? "从任意 cwd（/）调用可成功"
[ -f "$PORTAL/briefs/index.html" ]; check $? "内容落到 \$PORTAL/briefs/"

# 不带 PORTAL_REPO_DIR 时应指向脚本自身所在仓库
default_repo="$(cd "$SCRIPT_DIR/.." && pwd -P)"
grep -q 'DEFAULT_PORTAL_REPO="$( cd "$SCRIPT_DIR/.." && pwd -P )"' "$HELPER"
check $? "默认 portal repo 由脚本自身位置推导（${default_repo}）"

# ── 3. 正常发布 ──────────────────────────────────────────────────
echo ""
echo "[3] 正常发布"
setup_repo; setup_src
before="$(remote_head)"
PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
check $? "首次发布成功"
[ "$(git -C "$PORTAL" log -1 --pretty=%s)" = "content(briefs): publish static site" ]
check $? "commit message 为 content(briefs): publish static site"
[ "$(remote_head)" != "$before" ]; check $? "已 push 到 remote"
[ "$(remote_head)" = "$(local_head)" ]; check $? "remote 与本地一致"
[ ! -e "$PORTAL/briefs/.DS_Store" ]; check $? "排除 .DS_Store"
[ -f "$PORTAL/briefs/briefs/2026-08-31-morning.html" ]; check $? "内容目录镜像为 briefs/briefs/*.html"
[ -f "$PORTAL/index.html" ] && [ "$(cat "$PORTAL/index.html")" = "<html>portal</html>" ]
check $? "portal 根 index.html 未被子站覆盖"
[ -f "$PORTAL/CNAME" ]; check $? "CNAME 未被 --delete 删除"

# ── 4. 无变化时静默成功 ──────────────────────────────────────────
echo ""
echo "[4] 幂等"
head_before="$(local_head)"
stdout="$(PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" 2>/dev/null)"
check $? "重复发布退出码 0"
[ "$(local_head)" = "$head_before" ]; check $? "无变化时不产生新提交"
[ -z "$stdout" ]; check $? "无变化时 stdout 为空（静默成功）"

# ── 5. 只 add 自己的子目录 ───────────────────────────────────────
echo ""
echo "[5] 只提交自身子目录"
setup_repo; setup_src
PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
mkdir -p "$SRC-or"; echo "<html>or</html>" > "$SRC-or/index.html"
PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" openrouter "$SRC-or" >/dev/null 2>&1
check $? "发布 openrouter 成功"
files="$(git -C "$PORTAL" show --name-only --pretty=format: HEAD | grep -v '^$' | sort | tr '\n' ' ')"
[ "$files" = "openrouter/index.html " ]; check $? "openrouter 提交只含 openrouter/ 下的文件（实际: ${files}）"
[ -f "$PORTAL/briefs/index.html" ]; check $? "briefs 子站未被 openrouter 发布删除"

# ── 6. 工作树不 clean 时拒绝 ─────────────────────────────────────
echo ""
echo "[6] 工作树清洁度"
setup_repo; setup_src
echo "手写改动" >> "$PORTAL/index.html"
before="$(remote_head)"
PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
[ $? -ne 0 ]; check $? "工作树 dirty 时拒绝发布"
[ "$(remote_head)" = "$before" ]; check $? "拒绝后 remote 未变"
grep -q "手写改动" "$PORTAL/index.html"; check $? "拒绝后未回滚用户的本地改动"

setup_repo; setup_src
touch "$PORTAL/untracked.txt"
PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
[ $? -ne 0 ]; check $? "有 untracked 文件时也拒绝发布"

# ── 7. dry-run ───────────────────────────────────────────────────
echo ""
echo "[7] PUBLISH_DRY_RUN"
setup_repo; setup_src
before_local="$(local_head)"; before_remote="$(remote_head)"
PUBLISH_DRY_RUN=1 PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
check $? "dry-run 退出码 0"
[ "$(local_head)" = "$before_local" ]; check $? "dry-run 不产生本地提交"
[ "$(remote_head)" = "$before_remote" ]; check $? "dry-run 不 push"
[ -f "$PORTAL/briefs/index.html" ]; check $? "dry-run 仍然同步了文件"
[ -z "$(git -C "$PORTAL" diff --cached --name-only)" ]; check $? "dry-run 不 stage 任何文件"
# 上一次 dry-run 已经把文件写进工作树，先还原再测输出
git -C "$PORTAL" checkout -- briefs 2>/dev/null; git -C "$PORTAL" clean -qfd -- briefs
dr_out="$(PUBLISH_DRY_RUN=1 PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" 2>&1 >/dev/null)"
case "$dr_out" in *"dry-run"*) ok "dry-run 输出带标识";; *) bad "dry-run 输出带标识";; esac
# 还原 dry-run 留下的工作树改动
git -C "$PORTAL" checkout -- briefs 2>/dev/null; git -C "$PORTAL" clean -qfd -- briefs

# ── 8. 额外排除项 ────────────────────────────────────────────────
echo ""
echo "[8] PUBLISH_EXTRA_EXCLUDES"
setup_repo; setup_src
PUBLISH_EXTRA_EXCLUDES="portal/" PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
check $? "带 PUBLISH_EXTRA_EXCLUDES 发布成功"
[ ! -e "$PORTAL/briefs/portal" ]; check $? "portal/ 被排除，不会出现 /briefs/portal/"
[ -f "$PORTAL/briefs/index.html" ]; check $? "其余文件仍然发布"

# ── 9. --delete 语义 ─────────────────────────────────────────────
echo ""
echo "[9] rsync --delete"
rm "$SRC/js/app.js"
PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
check $? "源删除文件后发布成功"
[ ! -e "$PORTAL/briefs/js/app.js" ]; check $? "源端删除的文件在 portal 中被删除"
[ -f "$PORTAL/index.html" ]; check $? "--delete 不影响子目录之外"

# ── 10. 跨进程锁 ─────────────────────────────────────────────────
echo ""
echo "[10] 跨进程锁"
setup_repo; setup_src
LOCK="$PORTAL/.git/publish-subsite.lock"

# 10a. 锁被活着的进程持有 → 超时失败，而不是并发改仓库
sleep 30 & holder=$!
mkdir -p "$LOCK"; echo "$holder" > "$LOCK/pid"
start=$(date +%s)
PUBLISH_LOCK_TIMEOUT=2 PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
rc=$?; elapsed=$(( $(date +%s) - start ))
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
[ "$rc" -ne 0 ]; check $? "活锁被占用时等待超时并失败（${elapsed}s）"
[ "$elapsed" -ge 2 ]; check $? "确实等待了 PUBLISH_LOCK_TIMEOUT 秒"
[ -d "$LOCK" ]; check $? "超时退出不会误删别人持有的锁"
rm -rf "$LOCK"

# 10b. 持有者进程已死 → 自动清理僵死锁
mkdir -p "$LOCK"; echo "999999" > "$LOCK/pid"   # 几乎不可能存在的 pid
PUBLISH_LOCK_TIMEOUT=5 PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
check $? "持有者进程已退出时自动接管僵死锁"

# 10c. 锁目录存在但没有 pid 文件（进程在写 pid 前被 kill）→ 靠 mtime 兜底
mkdir -p "$LOCK"
PUBLISH_LOCK_STALE=0 PUBLISH_LOCK_TIMEOUT=5 PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
check $? "无 pid 文件的过期锁能被 mtime 兜底清理（不会永久死锁）"

# 10d. 正常结束后锁被释放
[ ! -e "$LOCK" ]; check $? "正常退出后释放锁"

# 10e. 失败路径（非法 site）也释放锁
PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" nope "$SRC" >/dev/null 2>&1 || true
[ ! -e "$LOCK" ]; check $? "非法参数退出后不残留锁"

# 10f. 中途被 kill 也不残留（trap INT/TERM）
setup_repo; setup_src
PORTAL_REPO_DIR="$PORTAL" PUBLISH_LOCK_TIMEOUT=60 bash -c '
  bash "$1" briefs "$2" >/dev/null 2>&1
' _ "$HELPER" "$SRC" &
victim=$!
kill -TERM "$victim" 2>/dev/null
wait "$victim" 2>/dev/null
[ ! -e "$LOCK" ]; check $? "被 TERM 杀掉后不残留锁"

# 10g. 两个并发任务互斥：串行完成，且两边内容都在
setup_repo; setup_src
mkdir -p "$SRC-or2"; echo "<html>or2</html>" > "$SRC-or2/index.html"
PORTAL_REPO_DIR="$PORTAL" PUBLISH_LOCK_TIMEOUT=60 bash "$HELPER" briefs     "$SRC"      >/dev/null 2>&1 &
p1=$!
PORTAL_REPO_DIR="$PORTAL" PUBLISH_LOCK_TIMEOUT=60 bash "$HELPER" openrouter "$SRC-or2"  >/dev/null 2>&1 &
p2=$!
wait "$p1"; r1=$?
wait "$p2"; r2=$?
[ "$r1" -eq 0 ] && [ "$r2" -eq 0 ]; check $? "两个并发发布都成功（r1=$r1 r2=${r2}）"
[ -f "$PORTAL/briefs/index.html" ] && [ -f "$PORTAL/openrouter/index.html" ]
check $? "并发发布后两个子站内容都在"
[ -z "$(git -C "$PORTAL" status --porcelain)" ]; check $? "并发发布后工作树 clean"
[ "$(remote_head)" = "$(local_head)" ]; check $? "并发发布后 remote 与本地一致"

# ── 11. 没有 origin 时不炸 ───────────────────────────────────────
echo ""
echo "[11] 无 remote"
setup_repo; setup_src
git -C "$PORTAL" remote remove origin
PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
check $? "没有 origin 时仍能本地提交成功"

# ── 12. ai-news 子站 ─────────────────────────────────────────────
echo ""
echo "[12] ai-news 子站"
setup_repo; setup_src; setup_ainews_src

before="$(remote_head)"
out="$(PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" ai-news "$AINEWS_SRC" 2>/dev/null)"
check $? "发布 ai-news 成功"
[ -f "$PORTAL/ai-news/index.html" ]; check $? "内容落到 \$PORTAL/ai-news/"
[ -f "$PORTAL/ai-news/data/news.json" ]; check $? "生成的 data/news.json 一并镜像"
[ "$(git -C "$PORTAL" log -1 --pretty=%s)" = "content(ai-news): publish static site" ]
check $? "commit message 为 content(ai-news): publish static site"
[ "$(remote_head)" != "$before" ]; check $? "ai-news 已 push 到 remote"
[ -n "$out" ]; check $? "有变更时 stdout 输出一行提交信息"
[ -f "$PORTAL/index.html" ] && [ "$(cat "$PORTAL/index.html")" = "<html>portal</html>" ]
check $? "portal 根 index.html 未被 ai-news 覆盖"

# 与其他子站互不干扰
PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" briefs "$SRC" >/dev/null 2>&1
check $? "ai-news 之后再发布 briefs 成功"
files="$(git -C "$PORTAL" show --name-only --pretty=format: HEAD | grep -v '^$' | grep -c '^ai-news/' || true)"
[ "$files" = "0" ]; check $? "briefs 的提交里不含 ai-news/ 文件"
[ -f "$PORTAL/ai-news/index.html" ]; check $? "ai-news 未被 briefs 发布删除"

# 幂等
head_before="$(local_head)"
stdout="$(PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" ai-news "$AINEWS_SRC" 2>/dev/null)"
check $? "重复发布 ai-news 退出码 0"
[ "$(local_head)" = "$head_before" ]; check $? "ai-news 无变化时不产生新提交"
[ -z "$stdout" ]; check $? "ai-news 无变化时 stdout 为空"

# 内容更新后能同步（模拟 cron 并入一期新简报）
echo '{"schema_version":1,"briefs":[{"id":"morning-20260831-deadbeef"}]}' > "$AINEWS_SRC/data/news.json"
PORTAL_REPO_DIR="$PORTAL" bash "$HELPER" ai-news "$AINEWS_SRC" >/dev/null 2>&1
check $? "news.json 变更后发布成功"
grep -q "morning-20260831-deadbeef" "$PORTAL/ai-news/data/news.json"
check $? "portal 里的 news.json 已更新为新内容"

echo ""
echo "───────────────────────────────"
printf '通过 %d，失败 %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
