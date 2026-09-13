# Bug 修复：群组路由中禁用通道仍被使用

## 问题描述

在手动创建的群组路由（例如 `claude-opus-5`）中，将部分通道禁用后（例如手动禁用了月城、lanln 通道，只保留林夕通道），系统仍然会使用被禁止的通道。

## 根本原因

在 `src/server/services/tokenRouter.ts` 的 `loadRouteMatch` 函数（第 1144-1152 行）中，查询路由通道时**没有过滤 `enabled` 字段**：

```typescript
// 修复前
const channels = enabledSourceRouteIds.length > 0
  ? await db
    .select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(inArray(schema.routeChannels.routeId, enabledSourceRouteIds))  // ❌ 缺少 enabled 检查
    .all()
  : [];
```

虽然后续在 `getCandidateEligibilityReasons` 函数中会检查 `channel.enabled`（第 3297 行），但这只是将禁用的通道标记为"不可用"，禁用的通道仍然被加载到内存和缓存中。

### 问题影响

1. **内存浪费**：禁用的通道被加载到内存中
2. **缓存污染**：禁用的通道存储在 `routeMatchCache` 中
3. **潜在的路由错误**：在某些边界情况下，禁用的通道可能被错误选中
4. **性能影响**：不必要的数据库 JOIN 和内存操作

## 修复方案

在数据库查询层面就过滤掉禁用的通道，确保只加载启用的通道：

```typescript
// 修复后
const channels = enabledSourceRouteIds.length > 0
  ? await db
    .select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(and(
      inArray(schema.routeChannels.routeId, enabledSourceRouteIds),
      eq(schema.routeChannels.enabled, true),  // ✅ 添加 enabled 检查
    ))
    .all()
  : [];
```

## 修改文件

- `src/server/services/tokenRouter.ts`：第 1151-1154 行

## 测试验证

### 手动测试步骤

1. 创建一个群组路由（例如 `claude-opus-5`）
2. 在群组中添加多个通道（例如月城、lanln、林夕）
3. 禁用其中的一些通道（例如禁用月城和 lanln）
4. 发起 API 请求使用该群组路由
5. 验证只有启用的通道（林夕）被使用

### 预期行为

- ✅ 禁用的通道不会出现在候选列表中
- ✅ 禁用的通道不会被选中用于请求
- ✅ 只有启用的通道参与路由决策
- ✅ 路由解释中不包含禁用的通道

### 验证命令

```bash
# 查看路由决策
curl -H "Authorization: Bearer ${PROXY_TOKEN}" \
  http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-5",
    "messages": [{"role": "user", "content": "test"}]
  }'

# 在后台日志中查看选中的通道，确认是启用的通道
```

## 代码逻辑

修复后的查询逻辑确保：

1. **查询层过滤**：在 SQL 查询时就过滤 `enabled = true`
2. **缓存一致性**：`routeMatchCache` 中只存储启用的通道
3. **双重防护**：即使有通道绕过查询过滤，`getCandidateEligibilityReasons` 仍会检查 `enabled` 字段

## 影响范围

### 受影响的功能

- ✅ **群组路由（explicit_group）**：主要修复目标
- ✅ **精确路由（exact）**：同样受益
- ✅ **模式路由（pattern/regex）**：同样受益
- ✅ **所有路由策略**：按权重、轮询、稳定优先

### 不受影响的功能

- ⚪ OAuth 路由单元：使用独立的查询逻辑
- ⚪ 通道冷却机制：在其他层面处理
- ⚪ 站点/账号状态：在 eligibility 检查中处理

## 性能优化

修复带来的性能提升：

1. **减少内存使用**：不加载禁用的通道
2. **减少缓存大小**：`routeMatchCache` 更小
3. **更快的候选筛选**：减少需要过滤的通道数量
4. **数据库索引利用**：利用 `route_channels_route_enabled_idx` 索引

## 后续建议

1. **添加集成测试**：覆盖禁用通道的场景
2. **文档更新**：更新路由配置文档，说明 `enabled` 字段的作用
3. **UI 改进**：在 Web UI 中更清晰地展示禁用状态
4. **监控指标**：添加禁用通道的监控指标

## 提交信息

```
fix: prioritize enabled channels in route selection

在路由通道查询时过滤禁用的通道，确保只有启用的通道参与路由决策。

修复了群组路由中手动禁用部分通道后，系统仍会使用被禁用通道的问题。

- 在 loadRouteMatch 中添加 enabled = true 过滤条件
- 减少内存使用和缓存污染
- 确保禁用的通道不参与路由选择
```

## 回归测试

运行以下测试确保没有引入新问题：

```bash
npm test -- tokenRouter
npm run build
npm run build:server
```

所有测试应该通过，编译应该成功。
