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
MANIFEST=""
NO_LINKS=0
HAS_TITLE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --doc-id) DOC_ID="$2"; shift 2 ;;
    --space)  SPACE_ID="$2"; shift 2 ;;
    --parent) PARENT_ID="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --no-links) NO_LINKS=1; shift ;;
    --fresh) FRESH=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
    --keep-local-links) KEEP_LINKS=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done
KEEP_LINKS="${KEEP_LINKS:-0}"

if [ -z "$MD_FILE" ]; then
  echo "用法: $0 <a.md> [\"<文档标题>\"] [--doc-id N] [--space N] [--parent N] [--manifest 清单] [--no-links]" >&2
  exit 1
fi
[ -f "$MD_FILE" ] || { echo "文件不存在：$MD_FILE" >&2; exit 1; }
if [ -z "$TITLE" ] && [ -z "$DOC_ID" ]; then
  echo "新建文档必须给标题（覆盖已有文档时标题可省略，默认沿用线上标题）" >&2
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_BIN="$(mktemp -t scofendoc-import).bin"

sql() {
  ssh -o BatchMode=yes "$HOST" "mysql -u$DB_USER -p'$DB_PASS' $DB -N -B -e \"$1\"" 2>/dev/null
}

if [ -n "$DOC_ID" ]; then
  echo "==> 1/4 复用文档 #$DOC_ID 的协同房间"
  DOC_ROW="$(sql "select collab_key, workspace_id, title from doc where id=$DOC_ID and deleted=0")"
  COLLAB_KEY="$(echo "$DOC_ROW" | cut -f1)"
  if [ -z "$COLLAB_KEY" ]; then
    echo "文档 #$DOC_ID 不存在或已删除" >&2
    exit 1
  fi
  # 空间以文档实际归属为准：覆盖正文时不能把链接指到别的空间去
  SPACE_ID="$(echo "$DOC_ROW" | cut -f2)"
  DB_TITLE="$(echo "$DOC_ROW" | cut -f3)"
  if [ -n "$TITLE" ]; then
    sql "update doc set title='$TITLE', updated_at=now() where id=$DOC_ID"
  else
    # 不传标题就沿用线上标题（用户可能已经在界面里改过名，不能被文件名覆盖）
    TITLE="$DB_TITLE"
  fi
  # 覆盖正文意味着丢掉该文档上已有的在线编辑，重启协同服务确保内存里的旧状态不会盖回来
  RESTART=1
  # 在旧文档上原地替换，而不是换一份全新的历史：否则还连着的客户端会把旧内容推回来
  MERGE_BIN=""
  if [ "${FRESH:-0}" != "1" ]; then
    MERGE_BIN="$(mktemp -t scofendoc-old).bin"
    if ! scp -q "$HOST:$DATA_DIR/$COLLAB_KEY.bin" "$MERGE_BIN" 2>/dev/null; then
      rm -f "$MERGE_BIN"
      MERGE_BIN=""
    fi
  fi
else
  if [ -n "$PARENT_ID" ]; then
    PARENT_SPACE="$(sql "select workspace_id from doc where id=$PARENT_ID and deleted=0")"
    if [ -z "$PARENT_SPACE" ]; then
      echo "父文档 #$PARENT_ID 不存在或已删除" >&2
      exit 1
    fi
    # 以父文档所属空间为准，避免父子跨空间
    SPACE_ID="$PARENT_SPACE"
    echo "==> 1/4 在空间 #$SPACE_ID 的文档 #$PARENT_ID 下新建子文档"
    NEXT_SORT="$(sql "select coalesce(max(sort_order),0)+1 from doc where workspace_id=$SPACE_ID and parent_id=$PARENT_ID and deleted=0")"
  else
    echo "==> 1/4 在空间 #$SPACE_ID 新建文档记录"
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
echo "    文档 id=$DOC_ID  collabKey=$COLLAB_KEY  空间 #$SPACE_ID  《${TITLE}》"

echo "==> 2/4 转换 Markdown → Yjs 状态文件"
CONVERT_FLAGS=(--drop-first-h1 --self "$DOC_ID" --space "$SPACE_ID")
if [ "$NO_LINKS" = "1" ]; then
  :
elif [ -z "$MANIFEST" ]; then
  # 默认用仓库里的对照表：没有它就不知道「这篇 md 对应线上哪一篇」
  MANIFEST="$PROJECT_ROOT/tools/md-to-collab/link-manifest.json"
fi
if [ "$NO_LINKS" != "1" ] && [ -f "$MANIFEST" ]; then
  CONVERT_FLAGS+=(--manifest "$MANIFEST")
fi
if [ "$KEEP_LINKS" = "1" ]; then
  CONVERT_FLAGS+=(--keep-local-links)
fi
if [ -n "${MERGE_BIN:-}" ]; then
  CONVERT_FLAGS+=(--merge-into "$MERGE_BIN")
fi
node "$PROJECT_ROOT/tools/md-to-collab/md-to-ydoc.mjs" "$MD_FILE" "$TMP_BIN" "${CONVERT_FLAGS[@]}"

echo "==> 3/4 上传到协同房间"
# 关键顺序：必须「先停服务，再写文件」。
# 只要房间被加载过（有人正开着这篇，或上一次发布后服务已把文档读进内存），
# 服务在退出时会用内存里的旧状态覆盖磁盘 —— 直接 restart 会把刚上传的新正文冲掉。
if [ "$RESTART" = "1" ] && [ "${NO_RESTART:-0}" != "1" ]; then
  ssh -o BatchMode=yes "$HOST" 'systemctl stop scofendoc-collab' || true
fi
scp -q "$TMP_BIN" "$HOST:$DATA_DIR/$COLLAB_KEY.bin"

if [ "$RESTART" = "1" ] && [ "${NO_RESTART:-0}" != "1" ]; then
  echo "==> 启动协同服务（让它以新文件为准）"
  ssh -o BatchMode=yes "$HOST" 'systemctl start scofendoc-collab'
  sleep 2
  ssh -o BatchMode=yes "$HOST" 'systemctl is-active scofendoc-collab' >/dev/null || {
    echo "协同服务未起来，请查 journalctl -u scofendoc-collab" >&2; exit 1; }
fi

# 通知协同服务刷新正文检索索引。
# 走 RESTART=1 时服务重启本来就会全量重建，这里是幂等的（按 mtime 跳过未变文件）；
# 关键是 NO_RESTART=1 / RESTART=0 的旁路：服务没重启、写入钩子也没被触发，
# 不主动刷一次就会「正文发上去了但搜不到」。接口只绑回环，失败不影响发布主流程。
ssh -o BatchMode=yes "$HOST" 'bash -s' <<'EOS' >/dev/null 2>&1 || true
SECRET=$(grep '^JWT_SECRET=' /opt/scofendoc/collab/collab.env 2>/dev/null | cut -d= -f2-)
[ -n "$SECRET" ] || exit 0
TOKEN=$(printf '%s' "${SECRET}:search" | sha256sum | cut -d' ' -f1)
curl -sf --max-time 10 -X POST -H "X-Internal-Token: $TOKEN" \
  http://127.0.0.1:1235/internal/reindex >/dev/null || true
EOS

echo "==> 4/4 回读校验（确认线上文件可解析且结构完整）"
scp -q "$HOST:$DATA_DIR/$COLLAB_KEY.bin" "$TMP_BIN"
node "$PROJECT_ROOT/tools/md-to-collab/read-ydoc.mjs" "$TMP_BIN"
rm -f "$TMP_BIN"
if [ -n "${MERGE_BIN:-}" ]; then rm -f "$MERGE_BIN"; fi

echo
echo "完成：http://47.117.110.143/scofendoc/?space=${SPACE_ID}&doc=${DOC_ID}   文档 id=${DOC_ID}  《${TITLE}》"
