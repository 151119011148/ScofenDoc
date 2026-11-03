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
}
