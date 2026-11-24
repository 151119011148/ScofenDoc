package com.scofendoc.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.io.File;
import java.util.concurrent.TimeUnit;

/**
 * 本地开发时直出上传的图片。
 *
 * 生产走 Nginx 的 /scofendoc/files/ → /var/www/scofendoc-files/ alias，不经过 Java；
 * 但 vite dev server 只代理 /api，没有 Nginx，所以这里额外映射 /files/**，
 * 由 vite.config.ts 把 /scofendoc/files/** 重写过来，本地也能看到粘贴的图。
 */
@Configuration
public class FileAccessConfig implements WebMvcConfigurer {

    @Value("${scofendoc.files.dir:/var/www/scofendoc-files}")
    private String filesDir;

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        // 写相对路径时按当前工作目录解析，避免拼出 file:./xxx 这种无效 location
        String absolute = java.nio.file.Path.of(filesDir).toAbsolutePath().normalize().toString();
        registry.addResourceHandler("/files/**")
                .addResourceLocations("file:" + absolute + File.separator)
                .setCacheControl(CacheControl.maxAge(7, TimeUnit.DAYS).cachePublic());
    }
}
