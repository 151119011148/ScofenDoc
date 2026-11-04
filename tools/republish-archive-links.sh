#!/usr/bin/env bash
# 重发「引用了离线存档」的 22 篇正文，把它们里面的 CSDN存档/语雀 链接改写成站内深链。
#
# 做法：先停一次协同服务（避免内存旧状态回写），逐篇转换 + 覆盖 bin，最后统一启动。
# 单篇走 publish-md.sh 会各停一次服务，22 次重启太慢。
set -euo pipefail

HOST="${HOST:-root@47.117.110.143}"
DB="${DB:-scofen_doc}"
DB_USER="${DB_USER:-scofendoc}"
DB_PASS="${DB_PASS:-ScofenDoc@2026}"
DATA_DIR="${DATA_DIR:-/opt/scofendoc/collab/data}"
SRC="${SRC:-/Users/gaoying/Desktop/study/人生/职业规划/技术栈}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/tools/md-to-collab/link-manifest.json"

sql() { ssh -o BatchMode=yes "$HOST" "mysql -u$DB_USER -p'$DB_PASS' $DB -N -B -e \"$1\"" 2>/dev/null; }

cd "$SRC"
FILES=($(grep -lE "\]\((CSDN存档|语雀)/" *.md | sort))
echo "待重发 ${#FILES[@]} 篇"

# 预取：md 绝对路径 → docId / collabKey / 标题
TMP_LIST="$(mktemp -t republish-list)"
: > "$TMP_LIST"
for f in "${FILES[@]}"; do
  abs="$SRC/$f"
  hit="$(node -e "const m=require('$MANIFEST');const h=m[process.argv[1]];if(h)process.stdout.write(h.docId+' '+h.spaceId)" "$abs")"
  if [ -z "$hit" ]; then echo "!! 清单里没有 $f，跳过" >&2; continue; fi
  id="${hit%% *}"; space="${hit##* }"
  key="$(sql "select collab_key from doc where id=$id and deleted=0")"
  if [ -z "$key" ]; then echo "!! 文档 #$id 不存在，跳过 $f" >&2; continue; fi
  printf '%s\t%s\t%s\t%s\n' "$f" "$id" "$space" "$key" >> "$TMP_LIST"
done

echo "==> 停协同服务"
ssh -o BatchMode=yes "$HOST" 'systemctl stop scofendoc-collab' || true

FAILED=0
while IFS=$'\t' read -r f id space key; do
  bin="$(mktemp -t republish).bin"
  old="$(mktemp -t republish-old).bin"
  # 取旧 bin 做合并，保留 Yjs 历史（否则还连着的手机会把旧正文推回来）
  if scp -q "$HOST:$DATA_DIR/$key.bin" "$old" 2>/dev/null; then
    MERGE=(--merge-into "$old")
  else
    MERGE=()
  fi
  if node "$ROOT/tools/md-to-collab/md-to-ydoc.mjs" "$SRC/$f" "$bin" \
      --drop-first-h1 --self "$id" --space "$space" --manifest "$MANIFEST" \
      "${MERGE[@]}" 2>&1 | tail -3; then
    scp -q "$bin" "$HOST:$DATA_DIR/$key.bin"
    echo "    ok #$id $f"
  else
    echo "    !! 转换失败 $f" >&2
    FAILED=$((FAILED+1))
  fi
  rm -f "$bin" "$old"
done < "$TMP_LIST"

echo "==> 启动协同服务"
ssh -o BatchMode=yes "$HOST" 'systemctl start scofendoc-collab && sleep 2 && systemctl is-active scofendoc-collab'
rm -f "$TMP_LIST"
echo "完成，失败 $FAILED 篇"
