#!/usr/bin/env bash
# scripts/test-portal-links.sh
#
# 校验 barryai.cn 门户首页的入口链接：六个产品都要有入口，
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

grep -q '<title>BARRY RS</title>' "$PAGE" \
  && grep -q '<h1 id="hero-title" class="rise d2">BARRY RS</h1>' "$PAGE" \
  && grep -q '<p>BARRY RS</p>' "$PAGE"
check $? "首页品牌名称统一使用全大写 BARRY RS"

grep -q 'class="card" href="/briefs/"' "$PAGE"
check $? "项目区有 /briefs/ 入口"

grep -q 'class="card" href="/openrouter/"' "$PAGE"
check $? "项目区有 /openrouter/ 入口"

grep -q 'class="card" href="/token-gpu/"' "$PAGE"
check $? "项目区有 /token-gpu/ 入口"

grep -q 'class="card" href="/ai-news/"' "$PAGE"
check $? "项目区有 /ai-news/ 入口"

grep -q 'class="card" href="/research/"' "$PAGE"
check $? "项目区有 /research/ 入口"

grep -q 'class="card" href="/briefs/agent/"' "$PAGE"
check $? "项目区有 /briefs/agent/ 入口"

grep -q 'href="#projects"' "$PAGE" && grep -q 'id="projects"' "$PAGE"
check $? "导航「项目」锚点有效"

card_count="$(grep -c 'class="card" href="/' "$PAGE")"
[ "$card_count" -eq 6 ]
check $? "首页恰好展示六个项目卡片"

# 项目卡顺序与门户展示文案要稳定。
actual_order="$(grep -o 'class="card" href="/[^"]*"' "$PAGE" | sed 's/.*href="//; s/"$//' | paste -sd ' ' -)"
expected_order="/token-gpu/ /openrouter/ /briefs/ /ai-news/ /briefs/agent/ /research/"
[ "$actual_order" = "$expected_order" ]
check $? "项目卡顺序为 Token+GPU、Token量与分布、今天在涨啥、AI信号台、AI研究工作台、AI Research OS"

grep -q '<h3>Token量与分布看板</h3>' "$PAGE"
check $? "OpenRouter 项目卡标题为「Token量与分布看板」"

grep -q '每日AI热点：市场正在交易什么' "$PAGE"
check $? "今天在涨啥副标题已更新"

grep -q 'AI kol前沿消息高频跟踪' "$PAGE"
check $? "AI 信号台副标题已更新"

grep -q '全天候研究助理：私人研究与执行终端' "$PAGE"
check $? "AI 研究工作台副标题已更新"

grep -q 'AI/大模型/算力/科技研究笔记与可检索研究' "$PAGE"
check $? "AI Research OS 副标题已更新"

! grep -q '<b>barryai\.cn/briefs/agent</b>' "$PAGE" \
  && ! grep -q '<b>barryai\.cn/research</b>' "$PAGE"
check $? "AI 研究工作台与 AI Research OS 不再展示访问地址行"

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
