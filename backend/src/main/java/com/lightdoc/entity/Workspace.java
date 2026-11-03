package com.lightdoc.entity;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 空间（Workspace）：文档的顶层容器，也是权限边界——
 * 空间归属某个 owner，空间下所有文档的可见性都由这个 owner 决定。
 *
 * ownerId 为 null 是「升级前无登录版本」留下的历史数据，
 * 会在第一个用户注册时被认领（见 AuthService#adoptOrphanWorkspaces）。
 */
@Entity
@Table(name = "workspace", indexes = {
        @Index(name = "idx_workspace_owner", columnList = "owner_id")
})
public class Workspace {

    public enum Type { PERSONAL, TEAM }

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 100)
    private String name;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private Type type = Type.PERSONAL;

    @Column(length = 64)
    private String ownerName;

    /** 归属用户 id；null = 历史遗留空间，待首个注册用户认领 */
    @Column(name = "owner_id")
    private Long ownerId;

    @Column(nullable = false)
    private int sortOrder = 0;

    @Column(nullable = false)
    private LocalDateTime createdAt = LocalDateTime.now();

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public Type getType() { return type; }
    public void setType(Type type) { this.type = type; }

    public String getOwnerName() { return ownerName; }
    public void setOwnerName(String ownerName) { this.ownerName = ownerName; }

    public Long getOwnerId() { return ownerId; }
    public void setOwnerId(Long ownerId) { this.ownerId = ownerId; }

    public int getSortOrder() { return sortOrder; }
    public void setSortOrder(int sortOrder) { this.sortOrder = sortOrder; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
