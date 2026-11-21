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

grep -q 'rel="icon".*%3EBARRY%3C%2Ftext%3E.*%3ERS%3C%2Ftext%3E' "$PAGE"
check $? "浏览器 favicon 复用左上角 Barry RS 标识"

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
[ "$card_count" -eq 8 ]
check $? "首页恰好展示八个项目卡片"

# 项目卡顺序与门户展示文案要稳定。
actual_order="$(grep -o 'class="card" href="/[^"]*"' "$PAGE" | sed 's/.*href="//; s/"$//' | paste -sd ' ' -)"
expected_order="/token-gpu/ /openrouter/ /briefs/ /ai-news/ /briefs/agent/ /research/ /random/blocks/ /texas/"
[ "$actual_order" = "$expected_order" ]
check $? "项目卡顺序为 Token+GPU、Token量与分布、今天在涨啥、AI信号台、AI研究工作台、AI Research OS、掷筊、德州扑克"

grep -q '<h3>Token量与分布看板</h3>' "$PAGE"
check $? "OpenRouter 项目卡标题为「Token量与分布看板」"

# 卡片精简（2026-11-21）：标题下最多两行，只有 01 保留副标题，其余只留一行范围/能力/内容。
desc_count="$(grep -c 'class="desc"' "$PAGE")"
[ "$desc_count" -eq 1 ] && grep -q '大模型 <span class="keep">Token</span> 成本与 GPU 租赁基准的统一跟踪' "$PAGE"
check $? "项目卡只有 Token + GPU 保留副标题"

rows_ok=1
while IFS= read -r n; do [ "$n" -le 1 ] || rows_ok=0; done < <(awk '/<a class="card"/{c=0} /class="row"/{c++} /<\/a>/{if(c) print c; c=0}' "$PAGE")
[ "$rows_ok" -eq 1 ]
check $? "每张项目卡最多一行信息"

! grep -q '<b>barryai\.cn/briefs/agent</b>' "$PAGE" \
  && ! grep -q '<b>barryai\.cn/research</b>' "$PAGE"
check $? "AI 研究工作台与 AI Research OS 不再展示访问地址行"

! grep -q 'gpu.latest.neo_h100\|ornn.latest.b200' "$PAGE"
check $? "Token + GPU 卡片不再引用旧的 H100 / Ornn 序列"

! grep -q "p.cn_share" "$PAGE"
check $? "Token量与分布卡片不再展示中国模型份额"

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
