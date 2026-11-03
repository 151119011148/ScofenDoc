package com.scofendoc.repository;

import com.scofendoc.entity.Doc;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface DocRepository extends JpaRepository<Doc, Long> {

    List<Doc> findByWorkspaceIdAndDeletedFalseOrderBySortOrderAscIdAsc(Long workspaceId);

    List<Doc> findByParentIdAndDeletedFalse(Long parentId);

    Optional<Doc> findByIdAndDeletedFalse(Long id);

    boolean existsByWorkspaceIdAndDeletedFalse(Long workspaceId);

    List<Doc> findByWorkspaceIdAndDeletedFalse(Long workspaceId);

    /** 含已软删除的整空间文档，供「撤销删除」把子树捞回来 */
    List<Doc> findByWorkspaceId(Long workspaceId);

    /** 跨空间搜索 / 最近更新：只看我加入的空间，按更新时间倒序 */
    List<Doc> findByWorkspaceIdInAndDeletedFalseOrderByUpdatedAtDesc(List<Long> workspaceIds);
}
