package com.scofendoc.controller;

import com.scofendoc.entity.Attachment;
import com.scofendoc.repository.AttachmentRepository;
import com.scofendoc.security.CurrentUser;
import com.scofendoc.service.DocumentService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
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

    /**
     * 危险扩展名：即使只以 attachment 下载，也不留可执行/可渲染的脚本文件
     */
    private static final Set<String> BLOCKED_EXT = Set.of(
            "html", "htm", "xhtml", "svg", "js", "mjs", "jsp", "jspx", "php",
            "asp", "aspx", "exe", "dll", "sh", "bat", "cmd", "ps1", "vbs", "jar");

    private final AttachmentRepository repo;
    private final DocumentService documents;

    @Value("${scofendoc.attachments.dir:/var/lib/scofendoc/attachments}")
    private String attachmentsDir;

    /**
     * 单个附件上限（MB），默认 500。
     * 与 spring.servlet.multipart.max-file-size、Nginx 的 client_max_body_size 三处要一起调，
     * 任何一处小都会被提前拒掉（Nginx 会直接 413，连 Controller 都进不来）。
     */
    @Value("${scofendoc.attachments.max-size-mb:500}")
    private long maxSizeMb;

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
        long maxBytes = maxSizeMb * 1024L * 1024L;
        if (file.getSize() > maxBytes) {
            throw new IllegalArgumentException("附件不能超过 " + maxSizeMb + "MB");
        }
        try (var in = file.getInputStream()) {
            return persist(docId, userId, safeFileName(file.getOriginalFilename()),
                    file.getContentType(), in);
        } catch (IOException e) {
            throw new IllegalArgumentException("无法读取上传的附件", e);
        }
    }

    /**
     * 裸二进制上传（前端默认走这个，不再用 multipart）。
     *
     * 起因：部分客户端网络环境（企业安全软件 / DLP / 出口设备）会把 multipart 的文件分段
     * 直接 RST 掉，浏览器表现为 ERR_CONNECTION_RESET，Nginx 日志里是
     * "recv() failed (104: Connection reset by peer)"；换成裸 body 后恢复正常。
     * 文件名放在 query 上（前端 encodeURIComponent 后传，Spring 自动解码），
     * 大小上限、危险扩展名、流式落盘等规则与 multipart 版本完全一致。
     *
     * multipart 的 /api/attachments 保留，兼容旧前端与既有调用方。
     */
    @PostMapping("/api/attachments/raw")
    public Map<String, Object> uploadRaw(HttpServletRequest request,
                                         @RequestParam("docId") Long docId,
                                         @RequestParam("name") String name,
                                         @RequestHeader(value = "Content-Type", required = false) String contentType) {
        Long userId = CurrentUser.id();
        documents.requireDocWrite(docId, userId);
        try (var in = request.getInputStream()) {
            return persist(docId, userId, safeFileName(name), contentType, in);
        } catch (IOException e) {
            throw new IllegalArgumentException("无法读取上传的附件", e);
        }
    }

    /** 两个上传入口共用的落盘 + 入库逻辑；流式复制，绝不把整个文件读进内存 */
    private Map<String, Object> persist(Long docId, Long userId, String original,
                                        String contentType, java.io.InputStream in) throws IOException {
        long maxBytes = maxSizeMb * 1024L * 1024L;
        String ext = extensionOf(original);
        if (BLOCKED_EXT.contains(ext)) {
            throw new IllegalArgumentException("不允许上传 ." + ext + " 类型的文件");
        }

        String month = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
        String stored = UUID.randomUUID().toString().replace("-", "");
        Path dir = Path.of(attachmentsDir, month);
        Path target = dir.resolve(stored);
        Path tmp = dir.resolve(stored + ".part");
        long written = 0;
        try {
            Files.createDirectories(dir);
            // 先写 .part 再原子改名，避免上传中断留下半截文件被当成正常附件
            try (var out = Files.newOutputStream(tmp)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) {
                    written += n;
                    if (written > maxBytes) {
                        throw new IllegalArgumentException("附件不能超过 " + maxSizeMb + "MB");
                    }
                    out.write(buf, 0, n);
                }
            }
            if (written == 0) {
                throw new IllegalArgumentException("附件内容为空");
            }
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        } catch (IllegalArgumentException e) {
            Files.deleteIfExists(tmp);
            throw e;
        } catch (IOException e) {
            try {
                Files.deleteIfExists(tmp);
            } catch (IOException ignored) {
                // 清理失败不影响主流程：残留的 .part 不会被当作附件读取
            }
            throw new IllegalStateException("附件保存失败，请检查服务器存储目录权限", e);
        }

        Attachment a = new Attachment();
        a.setDocId(docId);
        a.setStoredName(month + "/" + stored);
        a.setOriginalName(original);
        a.setContentType(contentType);
        a.setSizeBytes(written);
        a.setUploadedBy(userId);
        a = repo.save(a);

        return Map.of(
                "id", a.getId(),
                "name", original,
                "size", written,
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
        long length;
        try {
            if (!Files.isReadable(file)) {
                throw new IllegalStateException("附件文件已丢失或无法读取");
            }
            length = Files.size(file);
        } catch (IOException e) {
            throw new IllegalStateException("附件文件已丢失或无法读取", e);
        }
        // FileSystemResource 走流式输出并支持 Range，大附件不会整份读进内存
        Resource resource = new FileSystemResource(file);
        String encoded = URLEncoder.encode(a.getOriginalName(), StandardCharsets.UTF_8).replace("+", "%20");
        String disposition = "attachment; filename*=UTF-8''" + encoded;
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .contentLength(length)
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
