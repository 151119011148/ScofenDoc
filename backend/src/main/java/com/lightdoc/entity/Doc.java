package com.lightdoc.entity;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 文档元数据。
 *
 * 注意：正文不在 MySQL —— 正文是 Yjs 的 CRDT 二进制态，由 Node 协同服务
 * 落到 /opt/lightdoc/collab/data/{collabKey}.bin。这里只存目录结构所需的信息，
 * 其中 collabKey 就是协同房间名（前端连协同时用它）。
 *
 * parentId 为 null 表示根文档；非 null 表示是某文档的子文档，从而形成任意深度的父子树。
 */
@Entity
@Table(name = "doc", indexes = {
        @Index(name = "idx_doc_workspace", columnList = "workspace_id"),
        @Index(name = "idx_doc_parent", columnList = "parent_id"),
        @Index(name = "idx_doc_collab_key", columnList = "collab_key", unique = true)
})
public class Doc {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "workspace_id", nullable = false)
    private Long workspaceId;

    /** 父文档 id；null 表示根文档 */
    @Column(name = "parent_id")
    private Long parentId;

    @Column(nullable = false, length = 200)
    private String title;

    /** 协同房间名（UUID），与 Node 服务落盘文件名一致 */
    @Column(name = "collab_key", nullable = false, length = 64, unique = true)
    private String collabKey;

    /** 同级排序 */
    @Column(name = "sort_order", nullable = false)
    private int sortOrder = 0;

    /** 软删除：保留协同文件，误删可从库里恢复 */
    @Column(nullable = false)
    private boolean deleted = false;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt = LocalDateTime.now();

    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt = LocalDateTime.now();

    @PreUpdate
    public void touch() { this.updatedAt = LocalDateTime.now(); }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public Long getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(Long workspaceId) { this.workspaceId = workspaceId; }

    public Long getParentId() { return parentId; }
    public void setParentId(Long parentId) { this.parentId = parentId; }

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public String getCollabKey() { return collabKey; }
    public void setCollabKey(String collabKey) { this.collabKey = collabKey; }

    public int getSortOrder() { return sortOrder; }
    public void setSortOrder(int sortOrder) { this.sortOrder = sortOrder; }

    public boolean isDeleted() { return deleted; }
    public void setDeleted(boolean deleted) { this.deleted = deleted; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
