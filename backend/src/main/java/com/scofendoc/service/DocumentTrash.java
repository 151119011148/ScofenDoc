package com.scofendoc.service;

import com.scofendoc.entity.Doc;
import com.scofendoc.repository.DocRepository;
import com.scofendoc.repository.WorkspaceRepository;
import com.scofendoc.security.ForbiddenException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;

@Service
public class DocumentTrash {
    private static final Logger log = LoggerFactory.getLogger(DocumentTrash.class);
    private final DocRepository docs;
    private final WorkspaceRepository workspaces;
    private final MembershipService members;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final CollabOperations collab;
    private final Path attachments;

    public DocumentTrash(DocRepository docs, WorkspaceRepository workspaces,
                         MembershipService members, JdbcTemplate jdbc, TransactionTemplate tx,
                         CollabOperations collab, @Value("${scofendoc.attachments.dir}") String attachments) {
        this.docs = docs;
        this.workspaces = workspaces;
        this.members = members;
        this.jdbc = jdbc;
        this.tx = tx;
        this.collab = collab;
        this.attachments = Path.of(attachments).toAbsolutePath().normalize();
    }

    public record Entry(Long id, Long parentId, String title, LocalDateTime deletedAt, boolean cleanupPending) {}

    public List<Entry> list(Long workspace, Long actor) {
        boolean showPending = members.requireWrite(workspace, actor).role().canManage();
        return jdbc.query("""
                SELECT id,parent_id,title,updated_at,purged FROM doc
                WHERE workspace_id=? AND deleted=b'1' AND (purged=b'0' OR (? AND cleanup_complete=b'0'))
                ORDER BY updated_at DESC,id
                """, (rs, n) -> new Entry(rs.getLong(1), rs.getObject(2, Long.class), rs.getString(3),
                rs.getTimestamp(4).toLocalDateTime(), rs.getBoolean(5)), workspace, showPending);
    }

    public int purge(Long id, Long actor) {
        Long workspace = docs.workspaceIdOf(id).orElseThrow(() -> new ForbiddenException("文档不在回收站"));
        List<Long> pending = tx.execute(status -> {
            workspaces.lockById(workspace).orElseThrow(() -> new ForbiddenException("空间不存在"));
            Doc root = docs.lockById(id).filter(Doc::isDeleted)
                    .orElseThrow(() -> new ForbiddenException("文档不在回收站"));
            members.requireManage(root.getWorkspaceId(), actor);
            var ids = new ArrayList<Long>();
            var seen = new HashSet<Long>();
            var queue = new ArrayDeque<Doc>();
            queue.add(root);
            var all = docs.findByWorkspaceId(root.getWorkspaceId());
            while (!queue.isEmpty()) {
                Doc node = queue.remove();
                if (!seen.add(node.getId())) continue;
                // Each deletion batch is independent. Older deleted children stay in the trash.
                if (node != root && (root.getDeleteBatch() == null
                        || !Objects.equals(root.getDeleteBatch(), node.getDeleteBatch()))) continue;
                if (!node.isDeleted()) continue;
                ids.add(node.getId());
                all.stream().filter(d -> node.getId().equals(d.getParentId())).forEach(queue::add);
            }
            for (Long docId : ids) {
                jdbc.update("UPDATE doc SET purged=b'1' WHERE id=? AND deleted=b'1'", docId);
                jdbc.update("DELETE FROM doc_collaborator WHERE doc_id=?", docId);
                jdbc.update("DELETE FROM doc_share_link WHERE doc_id=?", docId);
            }
            return ids;
        });
        for (Long docId : pending) cleanup(docId);
        log.info("Document purged: doc={}, actor={}, count={}", id, actor, pending.size());
        return pending.size();
    }

    private void cleanup(Long id) {
        String room = jdbc.queryForObject("SELECT collab_key FROM doc WHERE id=? AND purged=b'1'", String.class, id);
        var rooms = jdbc.queryForList("SELECT room_key FROM doc_retired_room WHERE doc_id=?", String.class, id);
        rooms.add(room);
        collab.call("purge-doc", Map.of("docId", id.toString(), "rooms", rooms));
        var files = jdbc.queryForList("SELECT stored_name FROM attachment WHERE doc_id=?", String.class, id);
        try {
            for (String stored : files) {
                Path path = attachments.resolve(stored).normalize();
                if (!path.startsWith(attachments) || !stored.matches("[0-9]{6}/[0-9a-f]{32}")) {
                    throw new IOException("无效附件路径");
                }
                Files.deleteIfExists(path);
            }
        } catch (IOException e) {
            throw new IllegalStateException("文件清理失败，可从回收站重试", e);
        }
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM attachment WHERE doc_id=?", id);
            jdbc.update("DELETE FROM doc_retired_room WHERE doc_id=?", id);
            jdbc.update("UPDATE doc SET cleanup_complete=b'1', title='已永久删除' WHERE id=? AND purged=b'1'", id);
        });
    }
}
