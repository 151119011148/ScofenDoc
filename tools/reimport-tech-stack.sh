#!/usr/bin/env bash
# ============================================================================
# 批量重投「技术栈」27 篇文档，让 mermaid 图从旧 codeBlock 变成真正的 mermaid 节点。
#
# 用法：./tools/reimport-tech-stack.sh
#
# 原理：与 publish-md.sh 一致，但把「转换→上传→重启」合并成批处理，
# 只重启一次协同服务（而不是每篇重启一次）。
#
# 前置：已备份线上 bin（见 /tmp/lightdoc-backup-*）
# ============================================================================
set -euo pipefail

HOST="${HOST:-root@47.117.110.143}"
DB="${DB:-light_doc}"
DB_USER="${DB_USER:-lightdoc}"
DB_PASS="${DB_PASS:-LightDoc@2026}"
DATA_DIR="${DATA_DIR:-/opt/lightdoc/collab/data}"
MD_DIR="${MD_DIR:-../技术栈}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d -t lightdoc-reimport)"
trap 'rm -rf "$TMP_DIR"' EXIT

sql() {
  ssh -o BatchMode=yes -n "$HOST" "mysql -u$DB_USER -p'$DB_PASS' $DB -N -B -e \"$1\"" 2>/dev/null
}

# doc-id 与 md 文件名的映射（技术栈空间 space=2），格式「doc_id<TAB>md文件名」
MAP=$(cat <<'MAPEOF'
19	00-总索引.md
20	1.1-Java基础-章节导览.md
21	1.2-Java基础-OO三大特性.md
22	1.3-Java基础-集合框架.md
23	1.4-Java基础-并发线程.md
24	1.5-Java基础-IO.md
25	1.5.1-Java基础-Netty与网络编程.md
26	1.6-Java基础-JVM内存与GC.md
27	1.7-Java基础-JDK8-11-17新特性.md
28	2.1-Spring框架.md
29	2.2-MyBatis框架.md
30	2.3-Dubbo远程调用.md
31	2.4-ZooKeeper分布式协调.md
32	3.1-数据库-章节导览.md
33	3.2-MySQL-InnoDB.md
34	3.3-Redis缓存与分布式锁.md
35	3.4-HBase.md
36	3.5-Elasticsearch.md
37	3.6-图数据库.md
38	3.7-向量数据库.md
39	4.1-消息队列-章节导览.md
40	4.2-RocketMQ.md
41	4.3-Kafka.md
42	5.1-MBSE方法论与规范地图.md
43	5.1.1-模型互通-Rhapsody与Modelica转换.md
44	5.1.2-DDD与模型驱动.md
45	5.2-架构与高并发.md
MAPEOF
)

echo "==> 1/3 转换 27 篇 Markdown → Yjs 状态文件（本地）"
TOTAL=$(printf '%s\n' "$MAP" | wc -l | tr -d ' ')
IDX=0
# 把映射写入临时文件，用重定向读取（macOS bash 3.2 下进程替换与 ssh 交互不稳）
MAP_FILE="$TMP_DIR/map.txt"
printf '%s\n' "$MAP" > "$MAP_FILE"
while IFS=$'\t' read -r doc_id md; do
  [ -z "$doc_id" ] && continue
  IDX=$((IDX + 1))
  collab_key="$(sql "select collab_key from doc where id=$doc_id and deleted=0")"
  if [ -z "$collab_key" ]; then
    echo "    [跳过] doc #$doc_id 无 collab_key"
    continue
  fi
  printf '    [%2d/%2d] %-42s ' "$IDX" "$TOTAL" "$md"
  node "$PROJECT_ROOT/tools/md-to-collab/md-to-ydoc.mjs" "$MD_DIR/$md" "$TMP_DIR/$collab_key.bin" --drop-first-h1 --quiet && echo "ok" || { echo "失败"; exit 1; }
done < "$MAP_FILE"

echo "==> 2/3 上传全部 bin 到 $DATA_DIR"
scp -q "$TMP_DIR"/*.bin "$HOST:$DATA_DIR/"
UPLOADED=$(ls "$TMP_DIR"/*.bin | wc -l | tr -d ' ')
echo "    上传 $UPLOADED 个 bin"

echo "==> 3/3 重启协同服务（让房间以新文件为准）"
ssh -o BatchMode=yes "$HOST" 'systemctl restart lightdoc-collab'
sleep 2
ssh -o BatchMode=yes "$HOST" 'systemctl is-active lightdoc-collab' | grep -q active || {
  echo "协同服务未起来，请查 journalctl -u lightdoc-collab" >&2; exit 1; }
echo "    协同服务已重启并 active"

echo
echo "完成：已重投 $UPLOADED 篇文档，mermaid 图应能正常渲染"
