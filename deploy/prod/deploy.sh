#!/usr/bin/env bash
# ============================================================================
# 一键发布「轻量协同文档」到生产环境
#
# 用法（在本机项目根目录执行）：
#   ./deploy/prod/deploy.sh             # 全量发布
#   ./deploy/prod/deploy.sh frontend    # 只发前端
#   ./deploy/prod/deploy.sh backend     # 只发后端
#   ./deploy/prod/deploy.sh collab      # 只发协同服务
#
# 前置条件：本机能免密 ssh 到 $HOST；服务器已装 JDK17 / Node20 / Maven / MySQL8。
# ============================================================================
set -euo pipefail

HOST="${HOST:-root@47.117.110.143}"
PUBLIC_BASE="${PUBLIC_BASE:-/lightdoc/}"
SSH="ssh -o BatchMode=yes"
TARGET="${1:-all}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

deploy_frontend() {
  log "构建前端（base=${PUBLIC_BASE}）"
  ( cd frontend && VITE_BASE="${PUBLIC_BASE}" npm run build )

  log "上传静态产物到 /var/www/lightdoc"
  rsync -az --delete -e "$SSH" frontend/dist/ "$HOST:/var/www/lightdoc/"
}

deploy_collab() {
  log "上传协同服务源码"
  rsync -az --exclude node_modules --exclude data -e "$SSH" collab/ "$HOST:/opt/lightdoc/collab/"

  log "安装协同服务依赖"
  $SSH "$HOST" 'cd /opt/lightdoc/collab && npm install --omit=dev --registry=https://registry.npmmirror.com 2>&1 | tail -3'
}

deploy_backend() {
  log "上传后端源码"
  rsync -az --exclude target -e "$SSH" backend/ "$HOST:/opt/lightdoc/src-backend/"

  log "服务器上构建 JAR（跳过测试）"
  $SSH "$HOST" 'bash -s' <<'EOS'
set -e
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-17.0.20.0.8-1.1.0.2.1.al8.x86_64
export PATH=$JAVA_HOME/bin:/opt/maven/bin:$PATH
cd /opt/lightdoc/src-backend
MAVEN_OPTS="-Xmx400m -XX:MaxMetaspaceSize=192m" mvn -q -B -DskipTests clean package
cp target/light-doc-backend-0.1.0.jar /opt/lightdoc/app/light-doc-backend.jar
ls -lh /opt/lightdoc/app/light-doc-backend.jar
EOS
}

# 运行时环境变量：JWT 密钥只生成一次并长期复用。
# 换密钥会让所有人被迫重新登录、已签发的协同 token 全部失效，所以绝不每次发布重生成。
ensure_env() {
  log "校验运行时环境（JWT 密钥 / 数据库配置）"
  $SSH "$HOST" 'bash -s' <<'EOS'
set -e
mkdir -p /opt/lightdoc/app /opt/lightdoc/collab /opt/lightdoc/logs

SECRET_FILE=/opt/lightdoc/app/jwt.secret
if [ ! -s "$SECRET_FILE" ]; then
  # 只保留字母数字，避免 systemd EnvironmentFile 对特殊字符的解析歧义
  head -c 48 /dev/urandom | base64 | tr -d '\n=+/' > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  echo "JWT 密钥：新生成"
else
  echo "JWT 密钥：复用已有"
fi
SECRET=$(cat "$SECRET_FILE")

BE=/opt/lightdoc/app/backend.env
touch "$BE"
grep -q '^JAVA_HOME='   "$BE" || echo "JAVA_HOME=/usr/lib/jvm/java-17-openjdk-17.0.20.0.8-1.1.0.2.1.al8.x86_64" >> "$BE"
grep -q '^SERVER_PORT=' "$BE" || echo "SERVER_PORT=8081" >> "$BE"
grep -q '^DB_URL='      "$BE" || echo "DB_URL=jdbc:mysql://127.0.0.1:3306/light_doc?useUnicode=true&characterEncoding=utf8&useSSL=false&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true" >> "$BE"
grep -q '^DB_USER='     "$BE" || echo "DB_USER=lightdoc" >> "$BE"
grep -q '^DB_PASSWORD=' "$BE" || echo "DB_PASSWORD=LightDoc@2026" >> "$BE"
grep -q '^DB_POOL_SIZE=' "$BE" || echo "DB_POOL_SIZE=5" >> "$BE"
grep -q '^LOG_FILE='    "$BE" || echo "LOG_FILE=/opt/lightdoc/logs/backend.log" >> "$BE"
# 密钥每次都按密钥文件重写，确保后端与协同服务用的是同一个
sed -i '/^JWT_SECRET=/d' "$BE"
echo "JWT_SECRET=$SECRET" >> "$BE"
chmod 600 "$BE"

printf 'JWT_SECRET=%s\n' "$SECRET" > /opt/lightdoc/collab/collab.env
chmod 600 /opt/lightdoc/collab/collab.env
echo "环境变量就绪"
EOS
}

install_units_and_restart() {
  log "安装 systemd 单元与 Nginx 片段"  # -I（--ignore-times）：配置文件必须每次强制覆盖。
  # 默认 rsync 只比 size+mtime，曾出现过改了单元文件却没同步过去、
  # 导致协同服务拿不到 JWT_SECRET 的事故。
  rsync -azI -e "$SSH" deploy/prod/lightdoc-backend.service deploy/prod/lightdoc-collab.service deploy/prod/lightdoc.locations "$HOST:/opt/lightdoc/deploy/"

  $SSH "$HOST" 'bash -s' <<'EOS'
set -e
install -m 644 /opt/lightdoc/deploy/lightdoc-backend.service /etc/systemd/system/
install -m 644 /opt/lightdoc/deploy/lightdoc-collab.service /etc/systemd/system/
install -m 644 /opt/lightdoc/deploy/lightdoc.locations /etc/nginx/conf.d/lightdoc.locations
mkdir -p /opt/lightdoc/collab/data
systemctl daemon-reload
systemctl restart lightdoc-collab lightdoc-backend
nginx -t
systemctl reload nginx
EOS
}

health_check() {
  log "健康检查"
  $SSH "$HOST" 'bash -s' <<'EOS'
set -e
# 后端启动实测约 20s（JPA 建表 + 种子数据），这里轮询等待，最多 90s
for i in $(seq 1 45); do
  if curl -sf --max-time 3 http://127.0.0.1:8081/api/health >/dev/null 2>&1; then break; fi
  sleep 2
done
echo -n "后端 /api/health : "; curl -sS --max-time 8 http://127.0.0.1:8081/api/health; echo
echo -n "协同端点        : "; curl -sS -o /dev/null -w '%{http_code}\n' --max-time 8 http://127.0.0.1/lightdoc/collab
echo -n "前端首页        : "; curl -sS -o /dev/null -w '%{http_code}\n' --max-time 8 http://127.0.0.1/lightdoc/
# 接上 JWT 后这个接口应该返回 401 —— 401 恰恰说明权限已生效
echo -n "空间接口(应401) : "; curl -sS -o /dev/null -w '%{http_code}\n' --max-time 8 http://127.0.0.1:8081/api/workspaces
systemctl is-active lightdoc-backend lightdoc-collab nginx | paste -sd' '
EOS
}

case "$TARGET" in
  frontend) deploy_frontend ;;
  backend)  ensure_env; deploy_backend;  install_units_and_restart; health_check ;;
  collab)   ensure_env; deploy_collab;   install_units_and_restart; health_check ;;
  all)
    ensure_env
    deploy_frontend
    deploy_collab
    deploy_backend
    install_units_and_restart
    health_check
    ;;
  *) echo "未知目标：$TARGET（可选 all|frontend|backend|collab）" >&2; exit 1 ;;
esac

log "发布完成：http://${HOST#*@}${PUBLIC_BASE}"
