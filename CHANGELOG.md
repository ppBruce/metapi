# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Fixed
- **Antigravity 流式响应空回复问题**：修复 OpenAI 协议接口（chat completions / responses）调用 Antigravity 模型时流式返回空内容的问题
  - 原因：`response` 信封解包逻辑仅对 `gemini-cli` 平台生效，`antigravity` 平台被遗漏
  - 修复：新增 `isInternalGeminiPlatform()` 统一判定（覆盖 `gemini-cli` 和 `antigravity`），替换所有表面层硬编码平台比较
  - 影响文件：`chatSurface.ts`、`openAiResponsesSurface.ts`、`geminiSurface.ts`、`src/shared/platformIdentity.js`

### Added
- **Antigravity 生产环境 Base URL**：补全第三个上游 URL `cloudcode-pa.googleapis.com`（与 CLIProxyAPI 对齐）

- **toolConfig 自动提升**：顶层 `toolConfig` 现自动提升到 `request.toolConfig`（上游 `/v1internal` 接口要求的位置）
  - 镜像 CLIProxyAPI `geminiToAntigravity` 的 toolConfig 提升逻辑
  - 修复某些 tool 请求因结构不规范被上游拒绝的问题

- **动态 Antigravity User-Agent 追踪**：新增 `src/server/shared/antigravityVersion.ts` 模块
  - 从 Google Antigravity releases API 惰性拉取最新版本号（6 小时 TTL）
  - 替换所有硬编码 `antigravity/1.19.6 darwin/arm64` 为动态 `antigravityUserAgent()` 调用
  - 影响文件：`antigravityExecutor.ts`、`antigravityProviderProfile.ts`、`platformDiscoveryRegistry.ts`
  - 旧常量 `ANTIGRAVITY_MODELS_USER_AGENT` 标记为 `@deprecated`，暂保留以兼容外部引用

- **OAuth project_id 传递优化**：`antigravityExecutor.ts` 现优先使用真实 OAuth `projectId`，随机生成器降为最后兜底

- **JSON Schema 方言清理器**：新增 `src/server/transformers/gemini/generate-content/antigravitySchema.ts`（488 行）
  - 移植自 CLIProxyAPI `internal/util/gemini_schema.go`，适配 Antigravity / Gemini 的受限 Schema 方言
  - 支持 `$ref` 内联、`allOf` 合并、`anyOf`/`oneOf` 扁平化、不支持关键字移除、Claude VALIDATED 模式空 schema 占位符
  - `sanitizeAntigravityRequestSchemas()` 自动清理 `request.tools[].functionDeclarations[].parameters` 及 `generationConfig.responseSchema`
  - 已接入 `buildAntigravityRuntimeBody`，在请求发出前自动应用

- **Part 字段命名规范化**：`aggregator.ts` 新增 `normalizePartFieldCasing()`
  - 统一上游混用的 `thought_signature` / `inline_data`（snake_case）与 `thoughtSignature` / `inlineData`（camelCase）
  - 规范化后再进行文本 part 合并，避免同一 part 因字段拼写差异被拆分

### Changed
- **平台判定统一**：`src/shared/platformIdentity.js` 新增三个导出：
  - `isGeminiCliPlatform(platform)` / `isAntigravityPlatform(platform)` / `isInternalGeminiPlatform(platform)`
  - 所有平台字符串判定改为调用这些函数，确保 `anti-gravity` 别名也被正确识别

## [1.7.8] - 2024-09-XX
*(此前版本内容待补充)*
