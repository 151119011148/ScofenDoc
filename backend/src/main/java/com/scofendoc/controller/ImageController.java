package com.scofendoc.controller;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
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
 * 所以粘贴 / 拖入 / 选文件 / 按外链转存的图片都先落到这里，再由前端把返回的 URL 写成 image 节点。
 * 文件落盘目录与 Nginx 的 /scofendoc/files/ 静态映射指向同一处，无需改前端产物。
 */
@RestController
public class ImageController {

    /** 单张图片上限：截图通常远小于这个值，挡住误粘贴的大文件 */
    private static final long MAX_IMAGE_BYTES = 10L * 1024 * 1024;
    /** 按 URL 转存：连接/读取超时，避免一个坏地址把请求线程挂死 */
    private static final int CONNECT_TIMEOUT_MS = 5000;
    private static final int READ_TIMEOUT_MS = 10000;
    private static final int MAX_REDIRECTS = 3;

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
        return saveChecked(bytes, file.getContentType());
    }

    /**
     * 原始字节上传（前端默认走这个，不再用 multipart）。
     *
     * 起因：部分客户端网络环境（企业安全软件 / DLP / 出口设备）会把 multipart 的
     * 文件分段直接 RST 掉，表现为浏览器 ERR_CONNECTION_RESET、Nginx 日志里
     * "recv() failed (104: Connection reset by peer)"，而同样体积的裸二进制 body
     * 却能正常送达。改成 Content-Type 直接标图片类型的裸 body 后上传恢复，
     * 顺带省掉 boundary 编码开销。
     *
     * multipart 的 /api/images 保留，兼容旧前端与既有调用方。
     */
    @PostMapping("/api/images/raw")
    public Map<String, String> uploadRaw(
            HttpServletRequest request,
            @RequestHeader(value = "Content-Type", required = false) String contentType) {
        byte[] bytes;
        try {
            bytes = readLimited(request.getInputStream(), MAX_IMAGE_BYTES);
        } catch (IOException e) {
            throw new IllegalArgumentException("无法读取上传的图片", e);
        }
        return saveChecked(bytes, contentType);
    }

    /** 读 body 但最多留 MAX+1 字节，避免有人往这个接口灌几百兆把堆打爆 */
    private static byte[] readLimited(InputStream in, long limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        long total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            total += n;
            if (total > limit) {
                throw new IllegalArgumentException("图片不能超过 10MB");
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    /** 两条上传入口共用的校验：大小、文件头识别、落盘 */
    private Map<String, String> saveChecked(byte[] bytes, String contentType) {
        if (bytes == null || bytes.length == 0) {
            throw new IllegalArgumentException("图片内容为空");
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
            throw new IllegalArgumentException("图片不能超过 10MB");
        }
        String ext = detectExtension(bytes, contentType);
        if (ext == null) {
            throw new IllegalArgumentException("仅支持 PNG / JPEG / GIF / WEBP / BMP 图片");
        }
        return save(bytes, ext);
    }

    /**
     * 粘贴图文时，正文 HTML 里的外链图片（http/https）由服务端抓回来转存成本站地址。
     * 走后端而不是前端 fetch，是因为网页图片普遍有防盗链/CORS 限制，浏览器直接抓会失败。
     *
     * 安全：这是典型的 SSRF 入口，所以严格限制协议、目标 IP 段、跳转次数、超时和大小。
     */
    @PostMapping("/api/images/from-url")
    public Map<String, String> importByUrl(@RequestBody Map<String, String> body) {
        String raw = body == null ? null : body.get("url");
        if (raw == null || raw.isBlank()) {
            throw new IllegalArgumentException("图片地址为空");
        }
        Fetched fetched = fetchImage(raw.trim());
        String ext = detectExtension(fetched.bytes(), fetched.contentType());
        if (ext == null) {
            throw new IllegalArgumentException("目标不是支持的图片（PNG / JPEG / GIF / WEBP / BMP）");
        }
        return save(fetched.bytes(), ext);
    }

    /** 落盘并给出可访问 URL；两个入口共用，保证路径规则只有一处 */
    private Map<String, String> save(byte[] bytes, String ext) {
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

    private record Fetched(byte[] bytes, String contentType) {}

    /** 抓图：手动处理跳转，每一跳都重新校验，关闭自动重定向防止绕开 SSRF 检查 */
    private Fetched fetchImage(String raw) {
        URI uri;
        try {
            uri = new URI(raw);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("图片地址格式错误");
        }

        URI current = uri;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            assertPublicEndpoint(current);
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) current.toURL().openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (compatible; ScofenDoc/1.0)");
                int status = conn.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = conn.getHeaderField("Location");
                    if (location == null) {
                        throw new IllegalArgumentException("图片跳转地址缺失");
                    }
                    current = current.resolve(location);
                    continue;
                }
                if (status < 200 || status >= 300) {
                    throw new IllegalArgumentException("图片源返回 HTTP " + status);
                }
                String contentType = conn.getContentType();
                try (InputStream in = conn.getInputStream();
                     ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] buf = new byte[8192];
                    int total = 0;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        total += n;
                        if (total > MAX_IMAGE_BYTES) {
                            throw new IllegalArgumentException("图片不能超过 10MB");
                        }
                        out.write(buf, 0, n);
                    }
                    if (total == 0) {
                        throw new IllegalArgumentException("图片内容为空");
                    }
                    return new Fetched(out.toByteArray(), contentType);
                }
            } catch (IOException e) {
                throw new IllegalArgumentException("抓取图片失败：" + e.getMessage(), e);
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        throw new IllegalArgumentException("图片跳转次数过多");
    }

    /**
     * SSRF 防护：只放行公网 http(s)。把所有解析到的地址都检查一遍——
     * 只要有一个落在私网/保留段就整体拒绝，避免 DNS 解析到多个地址时的不确定性。
     */
    private static void assertPublicEndpoint(URI uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) {
            throw new IllegalArgumentException("只支持 http / https 图片地址");
        }
        String host = uri.getHost();
        if (host == null || host.isBlank() || uri.getPort() < -1) {
            throw new IllegalArgumentException("图片地址缺少有效主机");
        }
        String lower = host.toLowerCase(Locale.ROOT);
        if (lower.equals("localhost") || lower.endsWith(".localhost")) {
            throw new IllegalArgumentException("不允许访问本机地址");
        }
        InetAddress[] addresses;
        try {
            addresses = InetAddress.getAllByName(host);
        } catch (UnknownHostException e) {
            throw new IllegalArgumentException("图片地址无法解析：" + host);
        }
        if (addresses.length == 0) {
            throw new IllegalArgumentException("图片地址无法解析：" + host);
        }
        for (InetAddress addr : addresses) {
            if (addr.isLoopbackAddress() || addr.isLinkLocalAddress() || addr.isSiteLocalAddress()
                    || addr.isAnyLocalAddress() || addr.isMulticastAddress()) {
                throw new IllegalArgumentException("不允许访问内网或本机地址");
            }
            byte[] ip = addr.getAddress();
            // IPv4：0/8、100.64/10(CGNAT)、192.0.0/24、198.18/15、240/4 等保留段
            if (addr instanceof Inet4Address && ip.length == 4) {
                int a = ip[0] & 0xFF;
                int b = ip[1] & 0xFF;
                if (a == 0 || (a == 100 && b >= 64 && b <= 127)
                        || (a == 192 && b == 0) || (a == 198 && (b == 18 || b == 19)) || a >= 240) {
                    throw new IllegalArgumentException("不允许访问保留地址段");
                }
            }
            // IPv6：fc00::/7 唯一本地地址
            if (addr instanceof Inet6Address && ip.length == 16 && (ip[0] & 0xFE) == 0xFC) {
                throw new IllegalArgumentException("不允许访问内网 IPv6 地址");
            }
        }
    }

    /**
     * 按文件头判类型：剪贴板/外链图片常常没有文件名或 content-type，
     * 单靠 contentType 会误判成 application/octet-stream。
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
                && head[8] == 'W' && head[9] == 'E' && head[10] == 'W' && head[11] == 'P') {
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
