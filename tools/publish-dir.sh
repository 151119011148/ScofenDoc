#!/usr/bin/env bash
# ============================================================================
# 把一个目录下的 .md 批量发布到某个父文档下（按文件名排序决定同级顺序）
#
#   ./tools/publish-dir.sh "../技术栈" --parent 17
#   ./tools/publish-dir.sh "../技术栈" --parent 17 --space 2 --match '*.md'
#
# 每个文件的标题＝去掉扩展名的文件名；已发布的文件不会自动跳过，
# 重复执行会生成同名新文档（覆盖正文请用 publish-md.sh --doc-id）。
# ============================================================================
set -euo pipefail

DIR="${1:-}"
shift || true

PARENT_ID=""
SPACE_ID=1
MATCH="*.md"
while [ $# -gt 0 ]; do
  case "$1" in
    --parent) PARENT_ID="$2"; shift 2 ;;
    --space)  SPACE_ID="$2"; shift 2 ;;
    --match)  MATCH="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

if [ -z "$DIR" ] || [ -z "$PARENT_ID" ]; then
  echo "用法: $0 <目录> --parent <文档id> [--space N] [--match '*.md']" >&2
  exit 1
fi
[ -d "$DIR" ] || { echo "目录不存在：$DIR" >&2; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$(mktemp -t lightdoc-publish)"
: > "$LOG"   # 每篇追加写，失败时可回溯是第几篇

# macOS 自带 bash 3.2 没有 mapfile，这里用 while read 收集（顺序由 sort 保证）
FILES=()
while IFS= read -r line; do FILES+=("$line"); done < <(find "$DIR" -maxdepth 1 -type f -name "$MATCH" | sort)
TOTAL=${#FILES[@]}
echo "待发布 ${TOTAL} 个文件 → 父文档 #${PARENT_ID}（空间 #${SPACE_ID}）"
echo

IDX=0
OK=0
FAIL=0
for f in "${FILES[@]}"; do
  IDX=$((IDX + 1))
  TITLE="$(basename "$f")"
  TITLE="${TITLE%.*}"
  printf '[%2d/%2d] %-42s ' "$IDX" "$TOTAL" "$TITLE"
  if "$PROJECT_ROOT/tools/publish-md.sh" "$f" "$TITLE" --space "$SPACE_ID" --parent "$PARENT_ID" >>"$LOG" 2>&1; then
    DOC="$(grep -o '文档 id=[0-9]*' "$LOG" | tail -1 | cut -d= -f2)"
    echo "ok  (id=${DOC:-?})"
    OK=$((OK + 1))
  else
    echo "失败"
    tail -3 "$LOG" | sed 's/^/        /'
    FAIL=$((FAIL + 1))
  fi
done

echo
echo "完成：成功 ${OK}，失败 ${FAIL}（日志 ${LOG}）"
[ "$FAIL" -eq 0 ] || exit 1
