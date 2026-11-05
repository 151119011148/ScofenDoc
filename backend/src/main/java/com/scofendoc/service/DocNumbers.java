package com.scofendoc.service;

import com.scofendoc.entity.Doc;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 文档树章节号（1 / 1.1 / 1.1.1）的派生计算。
 *
 * 编号不落库、不写进 title：每次返回文档列表时按「父子树 + 同级顺序」实时算出来。
 * 这样拖动层级 / 顺序、新建、删除之后，编号自然跟着变，不会留下过期的旧号，
 * 也不需要批量改标题。与正文里 HeadingNumber 的「装饰派生」是同一套思路。
 *
 * 计数口径（与前端 DocTree 组树保持一致，否则两边显示会对不上）：
 *   - 每个空间各自从 1 开始，跨空间互不干扰；
 *   - 父节点不存在 / 已被软删的孤儿文档当作根节点；
 *   - 同级顺序按 sortOrder、id 升序（与 repository 的查询排序一致）；
 *   - 折叠状态不参与计算：收起子树不会让后面的编号跳号。
 */
public final class DocNumbers {

    private static final Comparator<Doc> SIBLING_ORDER =
            Comparator.comparingInt(Doc::getSortOrder).thenComparing(Doc::getId);

    /** 树的最大深度，仅用于防御脏数据造成的环，正常文档远达不到 */
    private static final int MAX_DEPTH = 64;

    private DocNumbers() {
    }

    /**
     * 批量算编号。入参可以跨空间（搜索结果就是跨空间的），内部按 workspaceId 分组。
     *
     * @param docs 未删除的文档；已软删的不要传进来，否则会占号
     * @return docId -> 章节号，如 1、1.2、1.2.3
     */
    public static Map<Long, String> of(List<Doc> docs) {
        Map<Long, List<Doc>> byWorkspace = docs.stream()
                .collect(Collectors.groupingBy(Doc::getWorkspaceId));
        Map<Long, String> out = new HashMap<>();
        for (List<Doc> group : byWorkspace.values()) {
            out.putAll(inWorkspace(group));
        }
        return out;
    }

    private static Map<Long, String> inWorkspace(List<Doc> docs) {
        Set<Long> alive = docs.stream().map(Doc::getId).collect(Collectors.toSet());

        Map<Long, List<Doc>> childrenByParent = new HashMap<>();
        List<Doc> roots = new ArrayList<>();
        for (Doc d : docs) {
            // 父 id 指向不存在的文档时按根处理，和前端 parentKey() 的兜底一致
            Long parent = d.getParentId();
            if (parent != null && alive.contains(parent)) {
                childrenByParent.computeIfAbsent(parent, k -> new ArrayList<>()).add(d);
            } else {
                roots.add(d);
            }
        }
        childrenByParent.values().forEach(list -> list.sort(SIBLING_ORDER));
        roots.sort(SIBLING_ORDER);

        Map<Long, String> out = new HashMap<>();
        Set<Long> onPath = new HashSet<>();
        for (int i = 0; i < roots.size(); i++) {
            walk(roots.get(i), String.valueOf(i + 1), childrenByParent, out, onPath, 1);
        }
        return out;
    }

    private static void walk(Doc doc, String number,
                             Map<Long, List<Doc>> childrenByParent,
                             Map<Long, String> out, Set<Long> onPath, int depth) {
        // 脏数据成环时直接停在这一支，不能让递归爆栈
        if (depth > MAX_DEPTH || !onPath.add(doc.getId())) return;
        out.put(doc.getId(), number);
        List<Doc> children = childrenByParent.getOrDefault(doc.getId(), List.of());
        for (int i = 0; i < children.size(); i++) {
            walk(children.get(i), number + "." + (i + 1), childrenByParent, out, onPath, depth + 1);
        }
        onPath.remove(doc.getId());
    }
}
