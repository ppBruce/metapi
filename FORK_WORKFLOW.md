# Fork 工作流说明

## 仓库关系

- **上游原始仓库**：https://github.com/wyf9661/metapi.git
- **你的 Fork 仓库**：https://github.com/ppBruce/metapi.git
- **本地仓库**：`/root/dockerComposeApp/metapi`

## 当前配置

```bash
# 远程仓库配置
origin   → git@github.com:ppBruce/metapi.git      (你的 GitHub，用于推送你的修改)
upstream → https://github.com/wyf9661/metapi.git  (上游原始仓库，用于拉取更新)
```

## 你的自定义修改

当前在分支 `local/1.7.9-custom` 上，包含以下功能修改：

1. **群组路由优先显示**：commit `bcb4346b` - 群组排在前面
2. **过滤群组内模型**：commit `36933dd1` - 已进入群组的模型不再单独显示
3. **禁用站点自动排序**：commit `2d59ac1c` - 禁用站点自动排在末尾
4. **站点状态徽章快速切换**：commit `e9466716` - 状态徽章点击切换 enabled/disabled
5. **代理通道故障转移设置 UI**：commit `d1639aa9` - 暴露 max attempts 与低价值 streak 阈值
6. **Docker 镜像配置**：commit `4d623905` - 使用 `metapi:1.7.X-custom` 镜像

### 已让位给上游的修改

- **允许删除站点上已不存在的本地令牌**：commit `7bf0ad17`，在合并上游 v1.7.9 时放弃。
  上游 `0a774c22` 把适配器返回值改为 `'deleted' | 'verified-absent' | 'unconfirmed'` 三态，
  其中 `verified-absent`（完整枚举站点令牌列表、无掩码、确认该 key 不在其中）已覆盖原场景，
  且在站点不可达或列表分页/掩码时保留本地记录，避免丢失仍然存活的凭据。

- **Antigravity 系列改动**：commit `6ad83cf8`、`1b1c829b`、`6f577b9b`、`3cb022eb`、`a77909f5`，
  已由 `547036a9`~`fa210316` 五个 revert 提交全部撤销，合并后 Antigravity 相关代码为纯上游实现。

## 日常工作流程

### 1. 同步上游更新（当 wyf9661 发布新版本时）

```bash
cd /root/dockerComposeApp/metapi

# 1. 拉取上游最新代码
git fetch upstream

# 2. 查看上游更新内容
git log upstream/main --oneline -10

# 3. 在当前分支上合并上游更新
git merge upstream/main

# 4. 如果有冲突，手动解决冲突后：
git add .
git commit -m "merge: resolve conflicts with upstream vX.X.X"

# 5. 运行类型检查确保代码正确
npm run typecheck

# 6. 重新构建 Docker 镜像
docker build -t metapi:1.7.X-custom .

# 7. 更新 docker-compose.yml 中的镜像版本
# image: metapi:1.7.X-custom

# 8. 重启容器验证
docker-compose up -d

# 9. 推送到你的 GitHub
git push origin local/1.7.X-custom
```

### 2. 保存你的新修改

```bash
cd /root/dockerComposeApp/metapi

# 1. 提交修改
git add <修改的文件>
git commit -m "feat: 描述你的修改"

# 2. 推送到你的 GitHub
git push origin local/1.7.9-custom
```

### 3. 创建新版本分支

当上游发布新大版本时（如 1.8.0），建议创建新分支：

```bash
# 1. 基于上游新版本创建本地分支
git checkout -b local/1.8.0-custom upstream/main

# 2. 将之前的修改应用到新分支（cherry-pick）
git cherry-pick bcb4346b  # 群组优先
git cherry-pick 36933dd1  # 过滤群组内模型
git cherry-pick 2d59ac1c  # 禁用站点排序

# 3. 解决可能的冲突并测试
npm run typecheck

# 4. 推送新分支到 GitHub
git push origin local/1.8.0-custom
```

## 告诉 AI 进行合并的标准说法

当上游更新时，可以这样告诉 AI：

```
合并上游 vX.X.X，保留本地修改，构建部署并推送到 GitHub
```

## 分支策略

- `main`：保持与上游同步（很少直接使用）
- `local/1.7.9-custom`：基于 1.7.9 的自定义分支（当前活跃）
- `local/1.7.8-custom`：基于 1.7.8 的自定义分支（保留为历史快照，不再维护）
- `local/1.7.7-custom`：基于 1.7.7 的自定义分支（保留为历史快照，不再维护）
- `local/1.7.6-custom`：基于 1.7.6 的自定义分支（历史版本）
- 未来会有 `local/1.8.0-custom` 等

## 注意事项

1. **永远不要直接修改 `main` 分支**，它应该保持与上游一致
2. **所有自定义修改都在 `local/X.X.X-custom` 分支上**
3. **推送前务必运行 `npm run typecheck`** 确保代码正确
4. **Docker 镜像命名规范**：`metapi:<version>-custom`
5. **定期推送到 GitHub**，避免本地修改丢失
6. **冲突决策**：当上游分支与本地修改出现冲突时，务必询问修改方案，手动确认。

## 快速命令参考

```bash
# 查看当前状态
git status
git log --oneline -5

# 查看远程仓库
git remote -v

# 拉取上游更新
git fetch upstream

# 推送到 GitHub
git push origin <当前分支名>

# 查看分支
git branch -a

# 构建镜像
docker build -t metapi:1.7.9-custom -f docker/Dockerfile .

# 重启容器
docker-compose up -d
```
