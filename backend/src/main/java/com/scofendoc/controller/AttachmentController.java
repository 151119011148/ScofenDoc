package com.scofendoc.controller;

import com.scofendoc.entity.Attachment;
import com.scofendoc.repository.AttachmentRepository;
import com.scofendoc.security.CurrentUser;
import com.scofendoc.service.DocumentService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 正文附件上传/下载。
 *
 * 与图片的区别：图片是公开静态资源（Nginx 直接托管），附件可能含敏感内容，
 * 所以文件本体落在独立目录（不进 Nginx 的 /scofendoc/files/ 映射），
 * 只能通过这里带鉴权取回，并按文档所属空间做成员权限校验。
 * 正文（Yjs）里只存 { id, name, size }，不存文件字节。
 */
@RestController
public class AttachmentController {

    /** 单个附件上限：50MB，覆盖绝大多数文档附件；再多走网盘更合适 */
    private static final long MAX_FILE_BYTES = 50L * 1024 * 1024;
    /** 危险扩展名：即使只以 attachment 下载，也不留可执行/可渲染的脚本文件 */
    private static final Set<String> BLOCKED_EXT = Set.of(
            "html", "htm", "xhtml", "svg", "js", "mjs", "jsp", "jspx", "php",
            "asp", "aspx", "exe", "dll", "sh", "bat", "cmd", "ps1", "vbs", "jar");

    private final AttachmentRepository repo;
    private final DocumentService documents;

    @Value("${scofendoc.attachments.dir:/var/lib/scofendoc/attachments}")
    private String attachmentsDir;

    public AttachmentController(AttachmentRepository repo, DocumentService documents) {
        this.repo = repo;
        this.documents = documents;
    }

    /**
     * 上传附件到某篇文档。返回 { id, name, size, url }；url 是带鉴权的下载接口地址，
     * 前端把它写进 attachment 节点，点击卡片时带 token 请求下载。
     * 要求当前用户对该文档有写权限（与编辑正文一致）。
     */
    @PostMapping("/api/attachments")
    public Map<String, Object> upload(@RequestParam("file") MultipartFile file,
                                      @RequestParam("docId") Long docId) {
        Long userId = CurrentUser.id();
        documents.requireDocWrite(docId, userId);

        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("附件内容为空");
        }
        if (file.getSize() > MAX_FILE_BYTES) {
            throw new IllegalArgumentException("附件不能超过 50MB");
        }
        String original = safeFileName(file.getOriginalFilename());
        String ext = extensionOf(original);
        if (BLOCKED_EXT.contains(ext)) {
            throw new IllegalArgumentException("不允许上传 ." + ext + " 类型的文件");
        }

        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException e) {
            throw new IllegalArgumentException("无法读取上传的附件", e);
        }
        if (bytes.length > MAX_FILE_BYTES) {
            throw new IllegalArgumentException("附件不能超过 50MB");
        }
        if (bytes.length == 0) {
            throw new IllegalArgumentException("附件内容为空");
        }

        String month = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
        String stored = UUID.randomUUID().toString().replace("-", "");
        Path dir = Path.of(attachmentsDir, month);
        Path target = dir.resolve(stored);
        try {
            Files.createDirectories(dir);
            Files.write(target, bytes, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.CREATE);
        } catch (IOException e) {
            throw new IllegalStateException("附件保存失败，请检查服务器存储目录权限", e);
        }

        Attachment a = new Attachment();
        a.setDocId(docId);
        a.setStoredName(month + "/" + stored);
        a.setOriginalName(original);
        a.setContentType(file.getContentType());
        a.setSizeBytes(bytes.length);
        a.setUploadedBy(userId);
        a = repo.save(a);

        return Map.of(
                "id", a.getId(),
                "name", original,
                "size", bytes.length,
                "url", "/api/attachments/" + a.getId() + "/download");
    }

    /**
     * 下载附件：要求当前用户对附件所属文档有读权限（VIEWER 也能下载）。
     * 一律以 Content-Disposition: attachment + application/octet-stream 返回，
     * 避免浏览器把 HTML/SVG 之类当页面内联渲染造成 XSS。
     */
    @GetMapping("/api/attachments/{id}/download")
    public ResponseEntity<Resource> download(@PathVariable Long id) {
        Long userId = CurrentUser.id();
        Attachment a = repo.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("附件不存在或已被清理"));
        // 用附件的 docId 校验，而不是让请求方传——防止伪造 docId 绕过权限
        documents.requireDocView(a.getDocId(), userId);

        Path file = Path.of(attachmentsDir, a.getStoredName());
        byte[] bytes;
        try {
            bytes = Files.readAllBytes(file);
        } catch (IOException e) {
            throw new IllegalStateException("附件文件已丢失或无法读取", e);
        }
        ByteArrayResource resource = new ByteArrayResource(bytes);
        String encoded = URLEncoder.encode(a.getOriginalName(), StandardCharsets.UTF_8).replace("+", "%20");
        String disposition = "attachment; filename*=UTF-8''" + encoded;
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .contentLength(bytes.length)
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition)
                .body(resource);
    }

    /** 去掉路径分隔符和首尾空白，防止原始文件名带路径穿越语义 */
    private static String safeFileName(String name) {
        if (name == null || name.isBlank()) return "attachment";
        String clean = name.replace('\\', '/');
        clean = clean.substring(clean.lastIndexOf('/') + 1).trim();
        return clean.isEmpty() ? "attachment" : clean;
    }

    /** 取小写扩展名（无点） */
    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 || dot == name.length() - 1
                ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }
}
