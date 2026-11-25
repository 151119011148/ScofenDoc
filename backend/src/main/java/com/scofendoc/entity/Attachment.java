package com.scofendoc.entity;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 正文附件元数据。文件本体落在独立目录（不在 Nginx 静态映射下），
 * 只能通过 /api/attachments/{id}/download 带鉴权取回，下载时从这里读原始文件名。
 * 正文（Yjs）里只存 id / name / size，不存文件字节。
 */
@Entity
@Table(name = "attachment", indexes = {
        @Index(name = "idx_attachment_doc", columnList = "doc_id")
})
public class Attachment {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** 所属文档 id：下载时用它做空间角色校验 */
    @Column(name = "doc_id", nullable = false)
    private Long docId;

    /** 落盘文件名（UUID），相对 attachments.dir/yyyyMM/ */
    @Column(name = "stored_name", nullable = false, length = 128)
    private String storedName;

    /** 原始文件名，下载时写进 Content-Disposition */
    @Column(name = "original_name", nullable = false, length = 500)
    private String originalName;

    @Column(name = "content_type", length = 200)
    private String contentType;

    @Column(name = "size_bytes", nullable = false)
    private long sizeBytes;

    @Column(name = "uploaded_by")
    private Long uploadedBy;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt = LocalDateTime.now();

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public Long getDocId() { return docId; }
    public void setDocId(Long docId) { this.docId = docId; }

    public String getStoredName() { return storedName; }
    public void setStoredName(String storedName) { this.storedName = storedName; }

    public String getOriginalName() { return originalName; }
    public void setOriginalName(String originalName) { this.originalName = originalName; }

    public String getContentType() { return contentType; }
    public void setContentType(String contentType) { this.contentType = contentType; }

    public long getSizeBytes() { return sizeBytes; }
    public void setSizeBytes(long sizeBytes) { this.sizeBytes = sizeBytes; }

    public Long getUploadedBy() { return uploadedBy; }
    public void setUploadedBy(Long uploadedBy) { this.uploadedBy = uploadedBy; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
