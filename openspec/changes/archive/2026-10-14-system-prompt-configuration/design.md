# Design

## Context

系统提示词当前硬编码在 `src/core/conversation/chat.ts` 中的 `SYSTEM` 常量。`HerStore` 使用 `settings` 表存储 `DesktopSettings` (JSON 字符串)，包含 `activeProfileId`、`shortcut`、`launchAtLogin` 三个字段。`SettingsPanel` 已有 `models` 和 `desktop` 两个 tab。

## Goals / Non-Goals

**Goals:**
- 在 `settings` 表的 JSON 中扩展 `systemPrompt` 字段存储用户提示词
- 新增独立 tab 让用户编辑和保存提示词
- `ChatService` 从数据库读取提示词替代硬编码常量
- 向后兼容：未配置时使用当前默认值

**Non-Goals:**
- 不支持为不同 profile 配置不同提示词（全局统一）
- 不支持提示词版本管理或历史记录
- 不支持提示词模板市场或分享

## Decisions

### 存储位置：扩展 DesktopSettings
**选择**: 在 `DesktopSettings` 接口新增 `systemPrompt?: string` 字段，存储在现有 `settings` 表的 JSON 中。

**理由**:
- 提示词是全局配置，与 `shortcut`、`launchAtLogin` 同类
- 无需数据库迁移，JSON 扩展字段向后兼容
- 读写使用现有 `getSettings()`/`setSettings()` 方法

**备选**:
- 独立 `system_prompt` 表 - 过度设计，单值不需要单独表
- 存入 `profiles` - 不合适，提示词是全局的而非 per-profile

### UI 结构：第三个独立 tab
**选择**: 在 `SettingsPanel` 新增第三个 tab `"system-prompt"`，与 `models`、`desktop` 并列。

**理由**:
- 提示词配置独立成章，避免与模型服务或桌面偏好混淆
- 单独 tab 可容纳较长提示词文本和说明
- 扩展性：未来可在此 tab 加入上下文长度等 AI 行为配置

**备选**:
- 放在 `desktop` tab - 逻辑不紧密，桌面偏好是系统级而非对话级
- 放在 `models` tab - 会与 profile 配置混淆

### 默认值处理
**选择**: `getSettings()` 返回时，若 `systemPrompt` 字段缺失，返回 `undefined`；`ChatService` 检查到 `undefined` 时使用硬编码的默认提示词常量。

**理由**:
- 向后兼容：现有数据库无此字段时自动使用默认值
- 不强制写入默认值到数据库，避免初次启动时不必要的写操作
- 保留 `chat.ts` 中的 `SYSTEM` 常量作为 fallback

### 字符长度限制
**选择**: 前端限制 16384 字符，后端验证并拒绝超长提示词。

**理由**:
- 16384 字符约等于模型的少量 token，对 system prompt 足够
- 避免用户输入过长提示词导致模型请求失败或浪费配额
- SQLite TEXT 类型无实际限制，但业务逻辑需设边界

## Risks / Trade-offs

**[风险] 用户输入不当的提示词导致模型回复质量下降** → 提供"恢复默认"按钮让用户快速回退；在 UI 显示当前默认提示词作为参考

**[风险] 用户不理解"系统提示词"概念** → tab 标题和说明文案使用简明语言（"Her 的性格和行为方式"），避免技术术语

**[权衡] 全局统一提示词 vs per-profile 提示词** → 当前选择全局统一，简化实现和用户理解；未来若有需求可扩展为 profile-level 覆盖

**[权衡] 不支持历史版本** → 用户无法撤销多步编辑；接受此限制以保持简单，未来可通过外部文本编辑器管理版本
