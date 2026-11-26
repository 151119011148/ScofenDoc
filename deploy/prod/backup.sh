#!/usr/bin/env bash
set -euo pipefail
umask 077

backup_dir="${SCOFENDOC_BACKUP_DIR:-/opt/scofendoc/backup}"
collab_dir="${COLLAB_DATA_DIR:-/opt/scofendoc/collab/data}"
images_dir="${SCOFENDOC_FILES_DIR:-/var/www/scofendoc-files}"
attachments_dir="${SCOFENDOC_ATTACHMENTS_DIR:-/var/lib/scofendoc/attachments}"
db="${SCOFENDOC_DB_NAME:-scofen_doc}"
mysql_config="${SCOFENDOC_MYSQL_CONFIG:-/root/.my.cnf}"

verify() {
  local archive
  archive="$(realpath -- "$1")"
  (cd "$(dirname -- "$archive")" && sha256sum --check --strict "$(basename -- "$archive").sha256")
  tar -tzf "$archive" >/dev/null
}

case "${1:-}" in
  create)
    mkdir -p -- "$backup_dir"
    exec 9>"$backup_dir/.p0-backup.lock"
    flock -n 9
    stage="$(mktemp -d -- "$backup_dir/.backup.XXXXXXXX")"
    backend_stopped=0
    collab_stopped=0
    finish() {
      local code=$?
      if (( collab_stopped )); then systemctl start scofendoc-collab || code=1; fi
      if (( backend_stopped )); then systemctl start scofendoc-backend || code=1; fi
      rm -rf -- "$stage"
      exit "$code"
    }
    trap finish EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    systemctl is-active --quiet scofendoc-backend
    systemctl is-active --quiet scofendoc-collab
    backend_stopped=1
    systemctl stop scofendoc-backend
    collab_stopped=1
    systemctl stop scofendoc-collab
    mkdir -p "$stage/payload/"{collab,images,attachments}
    mysqldump --defaults-extra-file="$mysql_config" --single-transaction --no-tablespaces \
      --set-gtid-purged=OFF "$db" > "$stage/payload/database.sql"
    cp -a --reflink=auto -- "$collab_dir/." "$stage/payload/collab/"
    if [[ -d "$images_dir" ]]; then cp -a --reflink=auto -- "$images_dir/." "$stage/payload/images/"; fi
    if [[ -d "$attachments_dir" ]]; then cp -a --reflink=auto -- "$attachments_dir/." "$stage/payload/attachments/"; fi
    systemctl start scofendoc-backend
    backend_stopped=0
    systemctl start scofendoc-collab
    collab_stopped=0

    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    name="scofendoc-$stamp.tar.gz"
    [[ ! -e "$backup_dir/$name" && ! -e "$backup_dir/$name.sha256" ]]
    tar -czf "$stage/$name" -C "$stage/payload" database.sql collab images attachments
    (cd "$stage" && sha256sum "$name" > "$name.sha256")
    verify "$stage/$name"
    mv -- "$stage/$name.sha256" "$backup_dir/$name.sha256"
    mv -- "$stage/$name" "$backup_dir/$name"
    printf '%s\n' "$backup_dir/$name"
    ;;
  verify)
    verify "${2:?请提供备份归档路径}"
    ;;
  stage)
    archive="$(realpath -- "${2:?请提供备份归档路径}")"
    target="${3:?请提供一个尚不存在的恢复目录}"
    verify "$archive"
    mkdir -m 700 -- "$target"
    tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$target"
    for entry in database.sql collab images attachments; do
      [[ -e "$target/$entry" ]]
    done
    printf '已解包到 %s\n' "$target"
    ;;
  *)
    printf '用法: bash %s create | verify <归档> | stage <归档> <新目录>\n' "$0" >&2
    exit 2
    ;;
esac
