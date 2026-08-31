#!/usr/bin/env bash
# scripts/test-portal-links.sh
#
# 校验 barryai.cn 门户首页的入口链接：两个产品都要有入口，
# 且都指向主站子路径，而不是旧的 briefs 子域。
#
# 用法：bash scripts/test-portal-links.sh [portal-index.html]

set -uo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"
PAGE="${1:-$SCRIPT_DIR/../index.html}"

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$1"; PASS=$(( PASS + 1 )); }
bad() { printf '  ✗ %s\n' "$1"; FAIL=$(( FAIL + 1 )); }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi; }

echo "门户首页链接检查：$PAGE"
echo ""

[ -f "$PAGE" ]; check $? "首页文件存在"
[ -f "$PAGE" ] || { echo "通过 $PASS，失败 $FAIL"; exit 1; }

grep -q 'class="cta" href="/briefs/"' "$PAGE"
check $? "首页 CTA 指向 /briefs/"

grep -q 'href="/openrouter/"' "$PAGE"
check $? "项目区有 /openrouter/ 入口"

grep -q 'href="#openrouter"' "$PAGE"
check $? "导航有 OpenRouter 锚点"

grep -q 'id="openrouter"' "$PAGE"
check $? "存在 id=\"openrouter\" 的项目块"

grep -q 'href="#brief"' "$PAGE" && grep -q 'id="brief"' "$PAGE"
check $? "导航「今天在涨啥」锚点仍然有效"

# CTA 与项目入口都不应再指向 briefs 子域（canonical / og:url 里的 barryai.cn 不算）
! grep -q 'href="https://briefs\.barryai\.cn' "$PAGE"
check $? "没有任何链接指向 https://briefs.barryai.cn"

! grep -q '<b>briefs\.barryai\.cn</b>' "$PAGE"
check $? "CTA 说明文案不再宣传 briefs 子域"

# 所有站内锚点都要有对应的 id
missing=""
while IFS= read -r anchor; do
  grep -q "id=\"${anchor}\"" "$PAGE" || missing="$missing $anchor"
done < <(grep -o 'href="#[a-zA-Z0-9_-]*"' "$PAGE" | sed 's/href="#//; s/"//' | sort -u)
[ -z "$missing" ]; check $? "所有站内锚点都有对应 id（缺失:${missing:- 无}）"

echo ""
printf '通过 %d，失败 %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
