package com.scofendoc.entity;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 空间成员：谁对这个空间有权限、以什么身份。
 *
 * 这里是**唯一的权限真相源**。workspace.owner_id 只表示"谁建的/谁是所有者"，
 * 真正的访问判定一律走这张表，否则共享空间没法表达。
 *
 * 三个角色：
 *   OWNER  —— 所有者，可管理成员、可删空间；一个空间有且仅有一个
 *   EDITOR —— 可读写：建/改/删文档、连协同
 *   VIEWER —— 只读：能看文档列表和正文，不能写
 *
 * (workspace_id, user_id) 唯一，避免同一人重复加入造成角色歧义。
 */
@Entity
@Table(name = "workspace_member",
        uniqueConstraints = @UniqueConstraint(name = "uk_member_workspace_user",
                columnNames = {"workspace_id", "user_id"}),
        indexes = {
                @Index(name = "idx_member_user", columnList = "user_id"),
                @Index(name = "idx_member_workspace", columnList = "workspace_id")
        })
public class WorkspaceMember {

    public enum Role {
        OWNER, EDITOR, VIEWER;

        /** 能否写（建/改/删文档、连协同编辑） */
        public boolean canWrite() {
            return this == OWNER || this == EDITOR;
        }

        /** 能否管理成员 */
        public boolean canManage() {
            return this == OWNER;
        }
    }

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "workspace_id", nullable = false)
    private Long workspaceId;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private Role role = Role.EDITOR;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt = LocalDateTime.now();

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public Long getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(Long workspaceId) { this.workspaceId = workspaceId; }

    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }

    public Role getRole() { return role; }
    public void setRole(Role role) { this.role = role; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
