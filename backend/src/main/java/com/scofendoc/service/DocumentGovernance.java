package com.scofendoc.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.scofendoc.entity.Doc;
import com.scofendoc.repository.DocRepository;
import com.scofendoc.repository.UserRepository;
import com.scofendoc.security.ForbiddenException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class DocumentGovernance {
    private static final Logger log = LoggerFactory.getLogger(DocumentGovernance.class);
    private final SecureRandom random = new SecureRandom();
    private final JdbcTemplate jdbc;
    private final DocRepository docs;
    private final UserRepository users;
    private final DocumentAccess access;
    private final PasswordEncoder passwords;
    private final CollabOperations collab;

    public DocumentGovernance(JdbcTemplate jdbc, DocRepository docs, UserRepository users,
                              DocumentAccess access, PasswordEncoder passwords, CollabOperations collab) {
        this.jdbc = jdbc;
        this.docs = docs;
        this.users = users;
        this.access = access;
        this.passwords = passwords;
        this.collab = collab;
    }

    public record Grant(Long userId, String username, String role) {}
    public record Link(Long id, Instant expiresAt, boolean passwordRequired) {}
    public record SharedDoc(Long id, String title, String role) {}
    public record ShareSettings(List<Grant> collaborators, List<Link> links) {}

    public Map<String, Object> permissions(Long id, Long actor) {
        var role = access.require(liveDoc(id), actor);
        return Map.of("role", role.name(), "canWrite", role.canWrite(), "canManage", role.canManage());
    }

    public ShareSettings settings(Long id, Long actor) {
        requireManager(liveDoc(id), actor);
        var grants = jdbc.query("""
                SELECT u.id,u.username,c.access_role FROM doc_collaborator c JOIN app_user u ON c.user_id=u.id
                WHERE c.doc_id=? ORDER BY u.username
                """, (r, n) -> new Grant(r.getLong(1), r.getString(2), r.getString(3)), id);
        var links = jdbc.query("""
                SELECT id,expires_at,password_hash IS NOT NULL FROM doc_share_link WHERE doc_id=? ORDER BY id DESC
                """, (r, n) -> new Link(r.getLong(1), r.getTimestamp(2).toInstant(), r.getBoolean(3)), id);
        return new ShareSettings(grants, links);
    }

    @Transactional
    public void grant(Long id, String username, DocumentAccess.Role role, Long actor) {
        requireManager(lockLive(id), actor);
        if (role == null || role == DocumentAccess.Role.OWNER) throw new IllegalArgumentException("请选择有效角色");
        Long userId = users.findByUsername(username == null ? "" : username.strip())
                .orElseThrow(() -> new IllegalArgumentException("账号不存在")).getId();
        jdbc.update("""
                INSERT INTO doc_collaborator (doc_id,user_id,access_role) VALUES (?,?,?)
                ON DUPLICATE KEY UPDATE access_role=?
                """, id, userId, role.name(), role.name());
        log.info("Document collaborator set: doc={}, actor={}, user={}, role={}", id, actor, userId, role);
    }

    @Transactional
    public void revokeGrant(Long id, Long userId, Long actor) {
        requireManager(lockLive(id), actor);
        jdbc.update("DELETE FROM doc_collaborator WHERE doc_id=? AND user_id=?", id, userId);
        log.info("Document collaborator removed: doc={}, actor={}, user={}", id, actor, userId);
    }

    @Transactional
    public Map<String, Object> createLink(Long id, int hours, String password, Long actor) {
        requireManager(lockLive(id), actor);
        if (hours < 1 || hours > 720) throw new IllegalArgumentException("有效期须为 1–720 小时");
        checkPasswordLength(password);
        byte[] secret = new byte[32];
        random.nextBytes(secret);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
        Instant expires = Instant.now().plus(hours, ChronoUnit.HOURS);
        jdbc.update("INSERT INTO doc_share_link (doc_id,token_hash,password_hash,expires_at) VALUES (?,?,?,?)",
                id, CollabOperations.digest(token),
                password == null || password.isEmpty() ? null : passwords.encode(password), Timestamp.from(expires));
        log.info("Document share link created: doc={}, actor={}, expires={}", id, actor, expires);
        return Map.of("token", token, "expiresAt", expires);
    }

    @Transactional
    public void revokeLink(Long id, Long link, Long actor) {
        requireManager(lockLive(id), actor);
        jdbc.update("DELETE FROM doc_share_link WHERE doc_id=? AND id=?", id, link);
        log.info("Document share link revoked: doc={}, actor={}, link={}", id, actor, link);
    }

    @Transactional(isolation = org.springframework.transaction.annotation.Isolation.READ_COMMITTED)
    public Map<String, Long> redeem(String token, String password, Long actor) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) throw invalidLink();
        checkPasswordLength(password);
        record Candidate(Long id, Long docId, String hash) {}
        List<Candidate> matches = jdbc.query("""
                SELECT id,doc_id,password_hash FROM doc_share_link WHERE token_hash=? AND expires_at>?
                """, (r, n) -> new Candidate(r.getLong(1), r.getLong(2), r.getString(3)),
                CollabOperations.digest(token), Timestamp.from(Instant.now()));
        if (matches.isEmpty()) throw invalidLink();
        Candidate link = matches.get(0);
        lockLive(link.docId());
        if (link.hash() != null && (password == null || !passwords.matches(password, link.hash()))) throw invalidLink();
        jdbc.update("""
                INSERT INTO doc_share_redemption (link_id,user_id)
                SELECT id,? FROM doc_share_link WHERE id=? AND expires_at>?
                ON DUPLICATE KEY UPDATE link_id=?
                """, actor, link.id(), Timestamp.from(Instant.now()), link.id());
        Integer valid = jdbc.queryForObject("""
                SELECT COUNT(*) FROM doc_share_link WHERE id=? AND expires_at>?
                """, Integer.class, link.id(), Timestamp.from(Instant.now()));
        if (valid == null || valid == 0) throw invalidLink();
        return Map.of("id", link.docId());
    }

    public List<SharedDoc> shared(Long actor) {
        List<Long> ids = jdbc.queryForList("""
                SELECT doc_id FROM doc_collaborator WHERE user_id=?
                UNION
                SELECT l.doc_id FROM doc_share_redemption r JOIN doc_share_link l ON r.link_id=l.id
                WHERE r.user_id=? AND l.expires_at>?
                """, Long.class, actor, actor, Timestamp.from(Instant.now()));
        return docs.findAllById(ids).stream().filter(d -> !d.isDeleted())
                .sorted(java.util.Comparator.comparing(Doc::getUpdatedAt).reversed())
                .map(d -> {
                    var role = access.role(d, actor);
                    return role == null ? null : new SharedDoc(d.getId(), d.getTitle(), role.name());
                }).filter(java.util.Objects::nonNull).toList();
    }

    public JsonNode versions(Long id, Long actor) {
        requireHistory(liveDoc(id), actor);
        return collab.call("versions", Map.of("docId", id.toString()));
    }

    @Transactional
    public JsonNode snapshot(Long id, String name, Long actor) {
        Doc doc = lockLive(id);
        if (!access.require(doc, actor).canWrite()) throw new ForbiddenException("文档仅可查看");
        if (name == null || name.isBlank() || name.strip().length() > 120) {
            throw new IllegalArgumentException("版本名称须为 1–120 字");
        }
        return collab.call("snapshot", Map.of("docId", id.toString(), "room", doc.getCollabKey(),
                "name", name.strip(), "actor", actor.toString()));
    }

    public JsonNode preview(Long id, String version, Long actor) {
        requireHistory(liveDoc(id), actor);
        return collab.call("version-preview", Map.of("docId", id.toString(), "version", version));
    }

    @Transactional
    public DocRoom restore(Long id, String version, Long actor) {
        Doc doc = lockLive(id);
        requireManager(doc, actor);
        String oldRoom = doc.getCollabKey();
        String newRoom = UUID.randomUUID().toString();
        var rooms = Map.of("docId", id.toString(), "room", oldRoom, "newRoom", newRoom);
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCompletion(int status) {
                if (status != STATUS_ROLLED_BACK) return;
                try {
                    collab.call("version-abort", rooms);
                } catch (RuntimeException e) {
                    log.warn("Could not discard uncommitted restore room: doc={}, room={}", id, newRoom, e);
                }
            }
        });
        collab.call("version-restore", Map.of("docId", id.toString(), "version", version,
                "room", oldRoom, "newRoom", newRoom, "actor", actor.toString()));
        jdbc.update("INSERT INTO doc_retired_room (doc_id,room_key) VALUES (?,?)", id, oldRoom);
        doc.setCollabKey(newRoom);
        log.info("Document version restored: doc={}, actor={}, version={}", id, actor, version);
        return new DocRoom(newRoom);
    }

    public record DocRoom(String collabKey) {}

    private void requireManager(Doc doc, Long actor) {
        if (!access.require(doc, actor).canManage()) throw new ForbiddenException("需要文档管理权限");
    }

    private void requireHistory(Doc doc, Long actor) {
        if (!access.require(doc, actor).canWrite()) throw new ForbiddenException("仅编辑者和管理者可查看版本历史");
    }

    private Doc liveDoc(Long id) { return docs.findByIdAndDeletedFalse(id).orElseThrow(this::denied); }
    private Doc lockLive(Long id) { return docs.lockById(id).filter(d -> !d.isDeleted()).orElseThrow(this::denied); }
    private ForbiddenException denied() { return new ForbiddenException("文档不存在或无权访问"); }
    private ForbiddenException invalidLink() { return new ForbiddenException("分享链接无效、已过期或密码错误"); }

    private void checkPasswordLength(String password) {
        if (password != null && password.getBytes(StandardCharsets.UTF_8).length > 72) {
            throw new IllegalArgumentException("链接密码不能超过 72 字节");
        }
    }
}
