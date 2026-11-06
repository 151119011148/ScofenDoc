package com.scofendoc.controller;

import com.scofendoc.dto.CollabTokenDto;
import com.scofendoc.dto.DocDto;
import com.scofendoc.dto.DocHitDto;
import com.scofendoc.dto.WorkspaceDto;
import com.scofendoc.entity.Workspace;
import com.scofendoc.security.AuthUser;
import com.scofendoc.security.CurrentUser;
import com.scofendoc.service.DocumentService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 空间与文档元数据接口。
 *
 * 正文不在这里 —— 正文由前端经 WebSocket 走 Node 协同服务（Yjs）同步。
 * 这里只负责：空间列表、文档树（扁平）、新建（含父子）、重命名、移动、软删除，
 * 外加签发协同 token。所有接口都要求登录，权限校验在 Service 层（成员表驱动）。
 */
@RestController
@RequestMapping("/api")
public class DocController {

    private final DocumentService service;

    public DocController(DocumentService service) {
        this.service = service;
    }

    /* ---------------- 空间 ---------------- */

    @GetMapping("/workspaces")
    public List<WorkspaceDto> workspaces() {
        return service.listWorkspaces(CurrentUser.id());
    }

    /** 新建空间：type=TEAM 才能邀请成员共享；kind 决定归入文档库还是知识库 */
    @PostMapping("/workspaces")
    public WorkspaceDto createWorkspace(@RequestBody Map<String, Object> body) {
        String name = body.get("name") == null ? null : String.valueOf(body.get("name"));
        Workspace.Type type = "TEAM".equalsIgnoreCase(String.valueOf(body.get("type")))
                ? Workspace.Type.TEAM : Workspace.Type.PERSONAL;
        Workspace.Kind kind = "KB".equalsIgnoreCase(String.valueOf(body.get("kind")))
                ? Workspace.Kind.KB : Workspace.Kind.DOC;
        return service.createWorkspace(name, type, kind, CurrentUser.get());
    }

    /**
     * 跨空间搜索标题 + 章节号 + 正文；q 为空即"最近更新"（主页用）。
     * 正文命中会在结果里带 snippet（上下文片段），供前端高亮展示。
     * limit 默认 20，服务端封顶 50。
     */
    @GetMapping("/docs/search")
    public List<DocHitDto> search(@RequestParam(required = false) String q,
                                  @RequestParam(defaultValue = "20") int limit) {
        return service.searchDocs(q, limit, CurrentUser.id());
    }

    /* ---------------- 文档 ---------------- */

    /** 某空间下的全部文档（扁平 + parentId），前端自行组树 */
    @GetMapping("/workspaces/{workspaceId}/docs")
    public List<DocDto> list(@PathVariable Long workspaceId) {
        return service.listDocs(workspaceId, CurrentUser.id());
    }

    @GetMapping("/docs/{id}")
    public DocDto get(@PathVariable Long id) {
        return service.getDoc(id, CurrentUser.id());
    }

    /** 新建文档；带 parentId 即为子文档 */
    @PostMapping("/docs")
    public DocDto create(@RequestBody CreateDocRequest req) {
        return service.createDoc(req.workspaceId(), req.parentId(), req.title(), CurrentUser.id());
    }

    /** 重命名 / 移动（改父级 + 改同级顺序） */
    @PatchMapping("/docs/{id}")
    public DocDto update(@PathVariable Long id, @RequestBody UpdateDocRequest req) {
        Long userId = CurrentUser.id();
        if (Boolean.TRUE.equals(req.moveParent())) {
            return service.moveDoc(id, req.parentId(), req.index(), userId);
        }
        return service.renameDoc(id, req.title(), userId);
    }

    /** 软删除（含整棵子树） */
    @DeleteMapping("/docs/{id}")
    public Map<String, Object> delete(@PathVariable Long id) {
        int n = service.deleteDoc(id, CurrentUser.id());
        return Map.of("deleted", n);
    }

    /** 撤销删除：恢复被软删的文档及其子树（前端 Ctrl+Z 用这个） */
    @PostMapping("/docs/{id}/restore")
    public Map<String, Object> restore(@PathVariable Long id) {
        int n = service.restoreDoc(id, CurrentUser.id());
        return Map.of("restored", n);
    }

    /** 协同 token：前端拿它连 WebSocket，只对本篇文档有效 */
    @GetMapping("/docs/{id}/collab-token")
    public CollabTokenDto collabToken(@PathVariable Long id) {
        AuthUser user = CurrentUser.get();
        return service.issueCollabToken(id, user);
    }

    public record CreateDocRequest(Long workspaceId, Long parentId, String title) {
    }

    /** index：拖拽落点在同级中的下标（null = 末尾） */
    public record UpdateDocRequest(String title, Long parentId, Boolean moveParent, Integer index) {
    }
}
