package com.scofendoc.controller;

import com.scofendoc.entity.Doc;
import com.scofendoc.repository.DocRepository;
import com.scofendoc.repository.UserRepository;
import com.scofendoc.security.ForbiddenException;
import com.scofendoc.security.JwtService;
import com.scofendoc.service.CollabOperations;
import com.scofendoc.service.DocumentAccess;
import io.jsonwebtoken.JwtException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Objects;

@RestController
public class CollabAccessController {
    private final byte[] internalKey;
    private final JwtService jwt;
    private final DocRepository docs;
    private final UserRepository users;
    private final DocumentAccess access;

    public CollabAccessController(@Value("${scofendoc.jwt.secret}") String secret, JwtService jwt,
                                  DocRepository docs, UserRepository users, DocumentAccess access) {
        this.internalKey = CollabOperations.digest(secret + ":collab-access").getBytes(StandardCharsets.US_ASCII);
        this.jwt = jwt;
        this.docs = docs;
        this.users = users;
        this.access = access;
    }

    @PostMapping("/internal/collab-access")
    public Lease authorize(@RequestHeader(value = "X-Internal-Token", defaultValue = "") String key,
                           @RequestBody Ticket ticket) {
        if (!MessageDigest.isEqual(internalKey, key.getBytes(StandardCharsets.US_ASCII))) throw denied();
        try {
            var claims = jwt.parse(ticket.token());
            if (!JwtService.TYP_COLLAB.equals(claims.get("typ", String.class))
                    || !Objects.equals(ticket.room(), claims.get("doc", String.class))) throw denied();
            Long userId = Long.valueOf(claims.getSubject());
            var user = users.findById(userId).orElseThrow(this::denied);
            if (!Objects.equals(claims.get("pv", Integer.class), user.getTokenVersion())) throw denied();
            Doc doc = docs.findByCollabKeyAndDeletedFalse(ticket.room()).orElseThrow(this::denied);
            var role = access.require(doc, userId);
            return new Lease(doc.getId().toString(), role.canWrite() && Boolean.TRUE.equals(claims.get("write", Boolean.class)));
        } catch (JwtException | IllegalArgumentException e) {
            throw denied();
        }
    }

    private ForbiddenException denied() { return new ForbiddenException("协同授权已失效"); }

    public record Ticket(String token, String room) {}
    public record Lease(String docId, boolean canWrite) {}
}
