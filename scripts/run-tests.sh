#!/usr/bin/env bash
# scripts/run-tests.sh —— 跑本仓库的全部测试
set -uo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"

rc=0
for t in test-publish-subsite.sh test-portal-links.sh test-barry-rs-logo.sh; do
  echo "═══ $t ═══"
  bash "$SCRIPT_DIR/$t" || rc=1
  echo ""
done

if [ "$rc" -eq 0 ]; then echo "全部测试通过"; else echo "有测试失败" >&2; fi
exit "$rc"
