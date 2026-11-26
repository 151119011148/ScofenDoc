package com.scofendoc.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Map;

@Component
public class CollabOperations {
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private final ObjectMapper mapper;
    private final URI base;
    private final String token;

    public CollabOperations(ObjectMapper mapper, @Value("${scofendoc.jwt.secret}") String secret,
                            @Value("${scofendoc.collab.search-url}") String searchUrl) {
        this.mapper = mapper;
        this.base = URI.create(searchUrl);
        this.token = digest(secret + ":search");
    }

    public JsonNode call(String operation, Map<String, ?> payload) {
        try {
            var request = HttpRequest.newBuilder(base.resolve(operation))
                    .timeout(Duration.ofSeconds(8))
                    .header("Content-Type", "application/json")
                    .header("X-Internal-Token", token)
                    .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(payload)))
                    .build();
            var response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 404) throw new IllegalArgumentException("版本不存在");
            if (response.statusCode() != 200) throw new IllegalStateException("协同服务未完成此操作，请重试");
            return mapper.readTree(response.body());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("协同操作已中断", e);
        } catch (IOException e) {
            throw new IllegalStateException("协同服务暂不可用", e);
        }
    }

    public static String digest(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
