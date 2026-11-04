#!/usr/bin/env bash
# ============================================================================
# 按对照表把「所有已发布的 md」重发一遍，补齐站内跳转链接
#
#   ./tools/relink-all.sh [对照表]
#
# 为什么整批重发：链接是正文的一部分，存在 Yjs 里；只改脚本不重发，
# 线上文档里那些链接仍然是纯文字。标题沿用线上标题（用户可能在界面里改过名）。
#
# 重发的代价：会覆盖该文档上已有的在线编辑。跑之前先备份 collab/data。
# ============================================================================
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${1:-$PROJECT_ROOT/tools/md-to-collab/link-manifest.json}"
HOST="${HOST:-root@47.117.110.143}"

[ -f "$MANIFEST" ] || { echo "对照表不存在：${MANIFEST}（先跑 build-link-manifest.mjs）" >&2; exit 1; }

MAP="$(mktemp -t scofendoc-relink-map)"
LOG="$(mktemp -t scofendoc-relink-log)"
: > "$LOG"

node -e '
const fs = require("fs")
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
for (const [file, hit] of Object.entries(m)) console.log([file, hit.docId, hit.spaceId].join("\t"))
' "$MANIFEST" > "$MAP"

TOTAL="$(wc -l < "$MAP" | tr -d ' ')"
OK=0
FAIL=0
INNER=0

echo "待重发 ${TOTAL} 篇（标题沿用线上，正文覆盖）"

# 整批期间把协同服务停掉：只要房间在内存里，服务退出时就会用旧状态覆盖刚写的文件。
# 停一次 → 逐篇写文件 → 最后启动一次，既避免覆盖，也避免 42 次重启。
echo "暂停协同服务（避免内存里的旧状态盖掉新正文）"
ssh -o BatchMode=yes "$HOST" 'systemctl stop scofendoc-collab'
trap 'ssh -o BatchMode=yes "$HOST" "systemctl start scofendoc-collab" >/dev/null 2>&1 || true' EXIT

while IFS=$'\t' read -r FILE DOC SPACE; do
  [ -n "$FILE" ] || continue
  NAME="$(basename "$FILE" .md)"
  printf '  #%-4s %-46s ' "$DOC" "$NAME"
  # 注意 < /dev/null：不重定向的话子脚本会吃掉 while 的 stdin，循环只跑第一轮
  if "$PROJECT_ROOT/tools/publish-md.sh" "$FILE" "" --doc-id "$DOC" --space "$SPACE" --no-restart >>"$LOG" 2>&1 < /dev/null; then
    LINE="$(grep -o '链接.*' "$LOG" | tail -1)"
    N="$(echo "$LINE" | sed -n 's/.*站内互引 \([0-9]*\) 处.*/\1/p')"
    INNER=$((INNER + ${N:-0}))
    OK=$((OK + 1))
    echo "ok  ${LINE:-}"
  else
    FAIL=$((FAIL + 1))
    echo "失败（见 ${LOG}）"
  fi
done < "$MAP"

if [ "$OK" -gt 0 ]; then
  echo
  echo "启动协同服务（让它以新文件为准）"
  ssh -o BatchMode=yes "$HOST" 'systemctl start scofendoc-collab'
  sleep 3
  ssh -o BatchMode=yes "$HOST" 'systemctl is-active scofendoc-collab' >/dev/null \
    && echo "协同服务已就绪" \
    || { echo "协同服务未起来，请查 journalctl -u scofendoc-collab" >&2; exit 1; }
fi

echo
echo "完成：成功 ${OK} 篇，失败 ${FAIL} 篇，站内链接合计 ${INNER} 处（日志 ${LOG}）"
