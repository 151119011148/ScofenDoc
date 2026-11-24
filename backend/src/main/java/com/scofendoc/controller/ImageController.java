package com.scofendoc.controller;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * 正文配图上传。
 *
 * 编辑器里的图片只存 URL（不把 base64 塞进 Yjs，否则 .bin 会随每次编辑暴涨），
 * 所以粘贴 / 拖入 / 选文件的图片先落到这里，再由前端把返回的 URL 写成 image 节点。
 * 文件落盘目录与 Nginx 的 /scofendoc/files/ 静态映射指向同一处，无需改前端产物。
 */
@RestController
public class ImageController {

    /** 单张粘贴图片上限：截图通常远小于这个值，挡住误粘贴的大文件 */
    private static final long MAX_IMAGE_BYTES = 10L * 1024 * 1024;

    @Value("${scofendoc.files.dir:/var/www/scofendoc-files}")
    private String filesDir;

    @Value("${scofendoc.files.url-prefix:/scofendoc/files/}")
    private String urlPrefix;

    /**
     * 上传一张图片，返回 { url: "/scofendoc/files/upload/202611/xxx.png" }。
     * 只认登录用户；VIEWER 即使拿到接口也改不了正文（editorProps.editable=false）。
     */
    @PostMapping("/api/images")
    public Map<String, String> upload(@RequestParam("file") MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("图片内容为空");
        }
        if (file.getSize() > MAX_IMAGE_BYTES) {
            throw new IllegalArgumentException("图片不能超过 10MB");
        }

        // 只读一次流：剪贴板上传的 MultipartFile 没有文件名，重复取流在部分容器实现上不稳
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException e) {
            throw new IllegalArgumentException("无法读取上传的图片", e);
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
            throw new IllegalArgumentException("图片不能超过 10MB");
        }
        String ext = detectExtension(bytes, file.getContentType());
        if (ext == null) {
            throw new IllegalArgumentException("仅支持 PNG / JPEG / GIF / WEBP / BMP 图片");
        }

        String month = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
        String name = UUID.randomUUID().toString().replace("-", "") + ext;
        Path dir = Path.of(filesDir, "upload", month);
        Path target = dir.resolve(name);
        try {
            Files.createDirectories(dir);
            Files.write(target, bytes, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.CREATE);
        } catch (IOException e) {
            // 落盘失败要明确告诉前端，否则用户会以为图已经插进去了
            throw new IllegalStateException("图片保存失败，请检查服务器存储目录权限", e);
        }

        String prefix = urlPrefix.endsWith("/") ? urlPrefix : urlPrefix + "/";
        return Map.of("url", prefix + "upload/" + month + "/" + name);
    }

    /**
     * 按文件头判类型：剪贴板里的图片常常没有 filename / content-type，
     * 单靠 MultipartFile.getContentType() 会误判成 application/octet-stream。
     */
    private static String detectExtension(byte[] head, String contentType) {
        if (head.length >= 8 && head[0] == (byte) 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G') {
            return ".png";
        }
        if (head.length >= 3 && (head[0] & 0xFF) == 0xFF && (head[1] & 0xFF) == 0xD8 && (head[2] & 0xFF) == 0xFF) {
            return ".jpg";
        }
        if (head.length >= 6 && head[0] == 'G' && head[1] == 'I' && head[2] == 'F' && head[3] == '8') {
            return ".gif";
        }
        if (head.length >= 12 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F'
                && head[8] == 'W' && head[9] == 'E' && head[10] == 'B' && head[11] == 'P') {
            return ".webp";
        }
        if (head.length >= 2 && head[0] == 'B' && head[1] == 'M') {
            return ".bmp";
        }
        String type = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT).trim();
        return switch (type) {
            case "image/png" -> ".png";
            case "image/jpeg" -> ".jpg";
            case "image/gif" -> ".gif";
            case "image/webp" -> ".webp";
            case "image/bmp" -> ".bmp";
            default -> null;
        };
    }
}
