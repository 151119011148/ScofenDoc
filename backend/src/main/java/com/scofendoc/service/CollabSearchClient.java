package com.scofendoc.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 调用协同服务的内网正文检索接口。
 *
 * 为什么正文检索在 Node 那边：正文是 Yjs CRDT 二进制，只有协同进程能解析，
 * Java 侧既没有 y-prosemirror 依赖、也不挂载 collab/data 目录。与其把正文再
 * 复制一份进 MySQL 并费力保证两边一致，不如让「唯一真相源」自己提供查询。
 *
 * 权限不在这个 client 里判：调用方只把「当前用户可见的 collabKey」传进来，
 * 协同服务只在这些 key 范围内搜，软删文档也不会出现在列表里。
 *
 * 协同服务没起来 / 超时 / 返回异常时一律返回空 Map 并降级为标题搜索 ——
 * 全文检索是增强能力，不能让搜索整体 500。
 */
@Component
public class CollabSearchClient {

    private static final Logger log = LoggerFactory.getLogger(CollabSearchClient.class);

    /** 单篇正文命中信息 */
    public record Hit(String key, int hits, String snippet) {
    }

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(400))
            .build();
    private final ObjectMapper mapper = new ObjectMapper();
    private final String url;
    private final String token;

    public CollabSearchClient(
            @Value("${scofendoc.jwt.secret}") String secret,
            @Value("${scofendoc.collab.search-url:http://127.0.0.1:1235/internal/search}") String url) {
        this.url = url;
        // 与 collab/server.js 的 SEARCH_TOKEN 用同一个派生方式（对 JWT_SECRET 做 SHA-256）
        this.token = sha256Hex(secret + ":search");
    }

    /**
     * @param keys  当前用户可见文档的 collabKey 列表（已过滤软删）
     * @param limit 最多取多少条正文命中，后端再与标题命中合并排序
     */
    public Map<String, Hit> search(String q, List<String> keys, int limit) {
        if (q == null || q.isBlank() || keys.isEmpty()) return Map.of();
        try {
            String body = mapper.writeValueAsString(Map.of(
                    "q", q,
                    "keys", keys,
                    "limit", limit));
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofMillis(1500))
                    .header("Content-Type", "application/json; charset=UTF-8")
                    .header("X-Internal-Token", token)
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> resp = http.send(req,
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (resp.statusCode() != 200) {
                log.warn("正文检索返回 {}，本次降级为标题搜索", resp.statusCode());
                return Map.of();
            }
            JsonNode arr = mapper.readTree(resp.body()).path("hits");
            Map<String, Hit> out = new HashMap<>();
            if (arr.isArray()) {
                for (JsonNode n : arr) {
                    String key = n.path("key").asText("");
                    if (!key.isEmpty()) {
                        out.put(key, new Hit(key, n.path("hits").asInt(1), n.path("snippet").asText("")));
                    }
                }
            }
            return out;
        } catch (Exception e) {
            log.warn("正文检索不可用，本次降级为标题搜索：{}", e.toString());
            return Map.of();
        }
    }

    private static String sha256Hex(String s) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256")
                    .digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
