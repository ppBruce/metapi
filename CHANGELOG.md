# Changelog

本文档记录 Metapi 自定义修改的行为变更（倒序，最新在上）。

---

## 2026-09-21 — 路由匹配优先级调整为：通配群组 > 普通群组 > 精确 pattern

**变更范围**：`src/server/services/tokenRouter.ts` `findRoute()` 方法

**新匹配顺序**（按优先级从高到低）：
1. **通配群组** — `routeMode='pattern'` + `modelPattern` 非精确（`re:` 或 glob `*`/`?`），按显示名或 pattern 命中
2. **普通群组** — `routeMode='explicit_group'`，按显示名命中
3. **精确 pattern** — `routeMode='pattern'` + `modelPattern` 精确值，按 pattern 相等或显示名命中

**变更原因**：通配群组通常聚合更多通道，候选池大时故障切换预算（`min(poolSize, 8)`）才有意义；单通道的精确路由作为兜底，而非首选。

**影响**：
- 若某模型名同时命中「带显示名的 `re:` 路由」和「精确路由」，现在走前者（之前走后者）
- 示例：模型 `gemini-3.8-flash` 同时命中路由 2408（`re:gemini-3.8`，7 通道）和路由 3352（精确 `gemini-3.8-flash`，1 通道），现在优先走 2408
- 带显示名的通配路由需确保 `model_mapping` 正确，否则下游通道可能收到未映射的模型名导致 400/404

**测试覆盖**：`src/server/services/tokenRouter.patterns.test.ts` 新增两条用例锁定新规则

---
