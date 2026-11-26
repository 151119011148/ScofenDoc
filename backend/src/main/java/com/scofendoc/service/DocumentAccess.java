package com.scofendoc.service;

import com.scofendoc.entity.Doc;
import com.scofendoc.security.ForbiddenException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.sql.Timestamp;

@Service
public class DocumentAccess {
    public enum Role {
        VIEWER, EDITOR, MANAGER, OWNER;
        public boolean canWrite() { return this != VIEWER; }
        public boolean canManage() { return ordinal() >= MANAGER.ordinal(); }
    }

    private final MembershipService membership;
    private final JdbcTemplate jdbc;

    public DocumentAccess(MembershipService membership, JdbcTemplate jdbc) {
        this.membership = membership;
        this.jdbc = jdbc;
    }

    public Role require(Doc doc, Long userId) {
        Role role = role(doc, userId);
        if (role == null) throw new ForbiddenException("文档不存在或无权访问");
        return role;
    }

    // Grants only add rights. A shared document never grants access to its parent, siblings or space.
    public Role role(Doc doc, Long userId) {
        if (doc.isDeleted()) return null;
        var inherited = membership.roleOf(doc.getWorkspaceId(), userId);
        if (inherited != null && inherited.canManage()) return Role.OWNER;
        Role role = inherited == null ? null : Role.valueOf(inherited.name());
        var grants = jdbc.queryForList(
                "SELECT access_role FROM doc_collaborator WHERE doc_id=? AND user_id=?",
                String.class, doc.getId(), userId);
        if (!grants.isEmpty()) {
            Role grant = Role.valueOf(grants.get(0));
            if (role == null || grant.ordinal() > role.ordinal()) role = grant;
        }
        if (role != null) return role;
        Integer links = jdbc.queryForObject("""
                SELECT COUNT(*) FROM doc_share_redemption r JOIN doc_share_link l ON r.link_id=l.id
                WHERE l.doc_id=? AND r.user_id=? AND l.expires_at>?
                """, Integer.class, doc.getId(), userId, Timestamp.from(Instant.now()));
        return links != null && links > 0 ? Role.VIEWER : null;
    }
}
