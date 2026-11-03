package com.lightdoc.entity;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 用户账号。
 *
 * 表名用 app_user 而不是 user：user 在 MySQL 8 里是保留关键字，
 * 直接当表名需要反引号，容易在各类工具里踩坑。
 *
 * 密码只存 BCrypt 哈希；color 是协同光标颜色，登录时一起发给前端，
 * 保证同一个人在不同文档里颜色一致（否则每次刷新光标颜色都在变）。
 */
@Entity
@Table(name = "app_user", indexes = {
        @Index(name = "idx_user_username", columnList = "username", unique = true)
})
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 64, unique = true)
    private String username;

    /** BCrypt 哈希，长度为 60，留 100 余量 */
    @Column(name = "password_hash", nullable = false, length = 100)
    private String passwordHash;

    @Column(name = "display_name", nullable = false, length = 64)
    private String displayName;

    /** 协同光标颜色，形如 #3370ff */
    @Column(nullable = false, length = 16)
    private String color = "#3370ff";

    /**
     * 是否管理员。第一个注册的用户自动成为管理员（否则关闭注册后没人能建号）。
     * 管理员可以创建账号、重置他人密码。
     */
    @Column(name = "is_admin", nullable = false)
    private boolean admin = false;

    /**
     * token 版本号。改密码 / 被管理员重置密码时 +1，
     * JwtAuthFilter 每次请求比对 token 里的 pv，版本对不上即视为失效。
     * 这样"改密码后其它设备立刻掉线"才是真的，而不是等 7 天 token 自然过期。
     */
    @Column(name = "token_version", nullable = false)
    private int tokenVersion = 0;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt = LocalDateTime.now();

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }

    public String getPasswordHash() { return passwordHash; }
    public void setPasswordHash(String passwordHash) { this.passwordHash = passwordHash; }

    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }

    public String getColor() { return color; }
    public void setColor(String color) { this.color = color; }

    public boolean isAdmin() { return admin; }
    public void setAdmin(boolean admin) { this.admin = admin; }

    public int getTokenVersion() { return tokenVersion; }
    public void setTokenVersion(int tokenVersion) { this.tokenVersion = tokenVersion; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
