#!/usr/bin/env bash
# ============================================================================
# 把一篇 Markdown 发布成线上协同文档
#
#   ./tools/publish-md.sh <a.md> "<文档标题>"                   # 新建一篇
#   ./tools/publish-md.sh <a.md> "<文档标题>" --doc-id 13      # 覆盖第 13 篇的正文
#   ./tools/publish-md.sh <a.md> "<文档标题>" --space 2        # 发到某个空间（默认 1 = 我的空间）
#
# 为什么需要脚本：正文不在 MySQL，而是 Yjs 文档，由协同服务落盘成
# /opt/scofendoc/collab/data/{collabKey}.bin。所以发布 = 造出与前端同构的
# Yjs 初始状态 + 建一条 doc 记录 + 把 bin 放进房间。
#
# 顺序提醒：**先发前端，再投数据**。旧版编辑器不认识新节点（比如表格），
# 一打开一保存就会把那部分内容洗掉，事后不可恢复（务必先备份 bin）。
# ============================================================================
set -euo pipefail

HOST="${HOST:-root@47.117.110.143}"
DB="${DB:-scofen_doc}"
DB_USER="${DB_USER:-scofendoc}"
DB_PASS="${DB_PASS:-ScofenDoc@2026}"
DATA_DIR="${DATA_DIR:-/opt/scofendoc/collab/data}"

MD_FILE="${1:-}"
TITLE="${2:-}"
shift 2 2>/dev/null || true

DOC_ID=""
SPACE_ID=1
PARENT_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --doc-id) DOC_ID="$2"; shift 2 ;;
    --space)  SPACE_ID="$2"; shift 2 ;;
    --parent) PARENT_ID="$2"; shift 2 ;;
    --keep-local-links) KEEP_LINKS=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done
KEEP_LINKS="${KEEP_LINKS:-0}"

if [ -z "$MD_FILE" ] || [ -z "$TITLE" ]; then
  echo "用法: $0 <a.md> \"<文档标题>\" [--doc-id N] [--space N] [--parent N]" >&2
  exit 1
fi
[ -f "$MD_FILE" ] || { echo "文件不存在：$MD_FILE" >&2; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_BIN="$(mktemp -t scofendoc-import).bin"

sql() {
  ssh -o BatchMode=yes "$HOST" "mysql -u$DB_USER -p'$DB_PASS' $DB -N -B -e \"$1\"" 2>/dev/null
}

echo "==> 1/4 转换 Markdown → Yjs 状态文件"
CONVERT_FLAGS=(--drop-first-h1)
if [ "$KEEP_LINKS" = "1" ]; then
  CONVERT_FLAGS+=(--keep-local-links)
fi
node "$PROJECT_ROOT/tools/md-to-collab/md-to-ydoc.mjs" "$MD_FILE" "$TMP_BIN" "${CONVERT_FLAGS[@]}"

if [ -n "$DOC_ID" ]; then
  echo "==> 2/4 复用文档 #$DOC_ID 的协同房间"
  COLLAB_KEY="$(sql "select collab_key from doc where id=$DOC_ID and deleted=0")"
  if [ -z "$COLLAB_KEY" ]; then
    echo "文档 #$DOC_ID 不存在或已删除" >&2
    rm -f "$TMP_BIN"
    exit 1
  fi
  sql "update doc set title='$TITLE', updated_at=now() where id=$DOC_ID"
  # 覆盖正文意味着丢掉该文档上已有的在线编辑，重启协同服务确保内存里的旧状态不会盖回来
  RESTART=1
else
  if [ -n "$PARENT_ID" ]; then
    PARENT_SPACE="$(sql "select workspace_id from doc where id=$PARENT_ID and deleted=0")"
    if [ -z "$PARENT_SPACE" ]; then
      echo "父文档 #$PARENT_ID 不存在或已删除" >&2
      rm -f "$TMP_BIN"
      exit 1
    fi
    # 以父文档所属空间为准，避免父子跨空间
    SPACE_ID="$PARENT_SPACE"
    echo "==> 2/4 在空间 #$SPACE_ID 的文档 #$PARENT_ID 下新建子文档"
    NEXT_SORT="$(sql "select coalesce(max(sort_order),0)+1 from doc where workspace_id=$SPACE_ID and parent_id=$PARENT_ID and deleted=0")"
  else
    echo "==> 2/4 在空间 #$SPACE_ID 新建文档记录"
    # 根文档默认排到最前（min-1），便于刚导入的文档一眼可见
    NEXT_SORT="$(sql "select coalesce(min(sort_order),1)-1 from doc where workspace_id=$SPACE_ID and parent_id is null and deleted=0")"
  fi

  COLLAB_KEY="$(ssh -o BatchMode=yes "$HOST" 'cat /proc/sys/kernel/random/uuid')"
  PARENT_SQL="NULL"
  [ -n "$PARENT_ID" ] && PARENT_SQL="$PARENT_ID"
  sql "insert into doc (workspace_id,parent_id,title,collab_key,sort_order,deleted,created_at,updated_at) values ($SPACE_ID,$PARENT_SQL,'$TITLE','$COLLAB_KEY',$NEXT_SORT,0,now(),now())"
  DOC_ID="$(sql "select id from doc where collab_key='$COLLAB_KEY'")"
  RESTART=0
fi
echo "    文档 id=$DOC_ID  collabKey=$COLLAB_KEY"

echo "==> 3/4 上传到协同房间"
scp -q "$TMP_BIN" "$HOST:$DATA_DIR/$COLLAB_KEY.bin"

if [ "$RESTART" = "1" ]; then
  echo "==> 重启协同服务（让房间以新文件为准）"
  ssh -o BatchMode=yes "$HOST" 'systemctl restart scofendoc-collab'
  sleep 2
  ssh -o BatchMode=yes "$HOST" 'systemctl is-active scofendoc-collab' >/dev/null || {
    echo "协同服务未起来，请查 journalctl -u scofendoc-collab" >&2; exit 1; }
fi

echo "==> 4/4 回读校验（确认线上文件可解析且结构完整）"
scp -q "$HOST:$DATA_DIR/$COLLAB_KEY.bin" "$TMP_BIN"
node "$PROJECT_ROOT/tools/md-to-collab/read-ydoc.mjs" "$TMP_BIN"
rm -f "$TMP_BIN"

echo
echo "完成：http://47.117.110.143/scofendoc/   文档 id=${DOC_ID}  《${TITLE}》"
