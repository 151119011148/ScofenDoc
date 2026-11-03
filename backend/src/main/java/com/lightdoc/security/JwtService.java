package com.lightdoc.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Date;

/**
 * JWT 签发与校验（HS256）。
 *
 * 两类 token，用 typ 声明区分，避免互相冒用：
 *   typ=auth   —— 登录态，访问 /api/**
 *   typ=collab —— 协同专用，带 doc=某个 collabKey，只能连这一个房间
 *
 * 密钥派生：把 JWT_SECRET 做一次 SHA-256 得到固定 32 字节密钥。
 * 这样无论运维填多短的字符串都不会触发 jjwt 的 WeakKeyException，
 * 也不会因为密钥长度不同而让算法在 HS256/384/512 之间漂移——
 * Node 协同服务端用同样的派生方式校验，两边必须保持一致。
 */
@Service
public class JwtService {

    public static final String TYP_AUTH = "auth";
    public static final String TYP_COLLAB = "collab";

    private final SecretKey key;
    private final long authTtlSeconds;
    private final long collabTtlSeconds;

    public JwtService(
            @Value("${lightdoc.jwt.secret}") String secret,
            @Value("${lightdoc.jwt.ttl-seconds:604800}") long authTtlSeconds,
            @Value("${lightdoc.jwt.collab-ttl-seconds:7200}") long collabTtlSeconds) {
        this.key = Keys.hmacShaKeyFor(sha256(secret));
        this.authTtlSeconds = authTtlSeconds;
        this.collabTtlSeconds = collabTtlSeconds;
    }

    /** 登录态 token；pv = 用户的 tokenVersion，改密后旧 token 会被过滤器判为失效 */
    public String issueAuthToken(AuthUser user, int tokenVersion) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(String.valueOf(user.id()))
                .claim("typ", TYP_AUTH)
                .claim("pv", tokenVersion)
                .claim("uname", user.username())
                .claim("dn", user.displayName())
                .claim("color", user.color())
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(authTtlSeconds)))
                .signWith(key, Jwts.SIG.HS256)
                .compact();
    }

    /** 协同 token：只对单个文档房间有效，短期，可随时靠过期收敛 */
    public String issueCollabToken(AuthUser user, String collabKey) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(String.valueOf(user.id()))
                .claim("typ", TYP_COLLAB)
                .claim("doc", collabKey)
                .claim("dn", user.displayName())
                .claim("color", user.color())
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(collabTtlSeconds)))
                .signWith(key, Jwts.SIG.HS256)
                .compact();
    }

    /** 校验并返回 claims；签名不对或过期抛 JwtException */
    public Claims parse(String token) throws JwtException {
        return Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
    }

    public long authTtlSeconds() {
        return authTtlSeconds;
    }

    public long collabTtlSeconds() {
        return collabTtlSeconds;
    }

    private static byte[] sha256(String secret) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return md.digest(secret.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("JVM 不支持 SHA-256", e);
        }
    }
}
