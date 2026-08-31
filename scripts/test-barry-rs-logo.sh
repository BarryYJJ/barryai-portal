#!/usr/bin/env bash
# scripts/test-barry-rs-logo.sh
#
# 校验公开镜像里每一个用户可见页面都带 Barry RS 首页标识：
#   · 恰好一个（机械迁移最容易犯的错是重复插入）；
#   · 链接是绝对地址 https://barryai.cn/，这样从 /openrouter/reports/
#     或 /briefs/briefs/ 这种嵌套路径点进去也能回到主站首页；
#   · 有可读的无障碍名称（aria-label 说明「返回 Barry RS 首页」）。
# 顺带校验看板改名：不再出现「OpenRouter 用量看板」。
#
# 用法：bash scripts/test-barry-rs-logo.sh [repo-root]

set -uo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"
ROOT="${1:-$( cd "$SCRIPT_DIR/.." && pwd -P )}"

HOME_URL="https://barryai.cn/"
OLD_NAME="OpenRouter 用量看板"
NEW_NAME="OpenRouter 看板"

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$1"; PASS=$(( PASS + 1 )); }
bad() { printf '  ✗ %s\n' "$1"; FAIL=$(( FAIL + 1 )); }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi; }

echo "Barry RS 首页标识检查：$ROOT"
echo ""

pages="$(find "$ROOT" -name '*.html' -not -path '*/.git/*' | sort)"
[ -n "$pages" ]; check $? "找到用户可见页面"

n_pages=0
missing=""; dupes=""; rel_href=""; no_label=""
while IFS= read -r page; do
  [ -n "$page" ] || continue
  n_pages=$(( n_pages + 1 ))
  rel="${page#"$ROOT"/}"

  # 标识锚点整行（每个页面的标识都写在同一行上）
  count="$(grep -c 'class="barry-rs-home"' "$page")"
  if [ "$count" -eq 0 ]; then
    missing="$missing $rel"
    continue
  elif [ "$count" -gt 1 ]; then
    dupes="$dupes $rel($count)"
    continue
  fi

  tag="$(grep -o '<a class="barry-rs-home"[^>]*>' "$page" | head -1)"
  printf '%s' "$tag" | grep -q "href=\"$HOME_URL\"" || rel_href="$rel_href $rel"
  printf '%s' "$tag" | grep -q 'aria-label="[^"]*Barry RS[^"]*首页' || no_label="$no_label $rel"
done <<< "$pages"

# 名单可能很长，只报前几个，够定位就行
brief() { set -- ${1:-}; [ "$#" -eq 0 ] && { printf ' 无'; return; }; printf ' %s' "$1" "${2:-}" "${3:-}"; [ "$#" -gt 3 ] && printf ' …共 %d 个' "$#"; }

[ -z "$missing" ]; check $? "所有页面都有 Barry RS 首页标识（缺失:$(brief "$missing")）"
[ -z "$dupes" ];   check $? "没有页面重复插入标识（重复:$(brief "$dupes")）"
[ -z "$rel_href" ]; check $? "标识一律指向绝对地址 ${HOME_URL}（不合格:$(brief "$rel_href")）"
[ -z "$no_label" ]; check $? "标识都有「返回 Barry RS 首页」无障碍名称（不合格:$(brief "$no_label")）"

printf '  · 共检查 %d 个页面\n' "$n_pages"

# ---------- 看板改名 ----------
echo ""
grep -q "$NEW_NAME" "$ROOT/index.html"
check $? "门户首页使用新名称「${NEW_NAME}」"

! grep -rq "$OLD_NAME" --include='*.html' "$ROOT"
check $? "任何页面都不再出现旧名称「${OLD_NAME}」"

grep -q "<title>$NEW_NAME" "$ROOT/openrouter/index.html"
check $? "看板页标题使用新名称"

echo ""
printf '通过 %d，失败 %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
