package com.scofendoc.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.scofendoc.security.CurrentUser;
import com.scofendoc.service.DocumentAccess;
import com.scofendoc.service.DocumentGovernance;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class DocumentGovernanceController {
    private final DocumentGovernance documents;

    public DocumentGovernanceController(DocumentGovernance documents) { this.documents = documents; }

    @GetMapping("/docs/{id}/permissions")
    public Map<String, Object> permissions(@PathVariable Long id) {
        return documents.permissions(id, CurrentUser.id());
    }

    @GetMapping("/docs/shared")
    public List<DocumentGovernance.SharedDoc> shared() {
        return documents.shared(CurrentUser.id());
    }

    @GetMapping("/docs/{id}/sharing")
    public DocumentGovernance.ShareSettings settings(@PathVariable Long id) {
        return documents.settings(id, CurrentUser.id());
    }

    @PostMapping("/docs/{id}/collaborators")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void grant(@PathVariable Long id, @RequestBody Grant body) {
        documents.grant(id, body.username(), body.role(), CurrentUser.id());
    }

    @DeleteMapping("/docs/{id}/collaborators/{user}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void revoke(@PathVariable Long id, @PathVariable Long user) {
        documents.revokeGrant(id, user, CurrentUser.id());
    }

    @PostMapping("/docs/{id}/share-links")
    public Map<String, Object> link(@PathVariable Long id, @RequestBody CreateLink body) {
        return documents.createLink(id, body.hours(), body.password(), CurrentUser.id());
    }

    @DeleteMapping("/docs/{id}/share-links/{link}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void revokeLink(@PathVariable Long id, @PathVariable Long link) {
        documents.revokeLink(id, link, CurrentUser.id());
    }

    @PostMapping("/docs/redeem-share")
    public Map<String, Long> redeem(@RequestBody Redeem body) {
        return documents.redeem(body.token(), body.password(), CurrentUser.id());
    }

    @GetMapping("/docs/{id}/versions")
    public JsonNode versions(@PathVariable Long id) {
        return documents.versions(id, CurrentUser.id());
    }

    @PostMapping("/docs/{id}/versions")
    public JsonNode snapshot(@PathVariable Long id, @RequestBody Snapshot body) {
        return documents.snapshot(id, body.name(), CurrentUser.id());
    }

    @GetMapping("/docs/{id}/versions/{version}")
    public JsonNode preview(@PathVariable Long id, @PathVariable String version) {
        return documents.preview(id, version, CurrentUser.id());
    }

    @PostMapping("/docs/{id}/versions/{version}/restore")
    public DocumentGovernance.DocRoom restore(@PathVariable Long id, @PathVariable String version) {
        return documents.restore(id, version, CurrentUser.id());
    }

    public record Grant(String username, DocumentAccess.Role role) {}
    public record CreateLink(int hours, String password) {}
    public record Redeem(String token, String password) {}
    public record Snapshot(String name) {}
}
