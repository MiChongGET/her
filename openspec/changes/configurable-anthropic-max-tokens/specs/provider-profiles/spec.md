# Spec Delta

## Purpose

定义模型服务配置如何被保存、校验，并决定发往上游模型服务的请求参数。本次变更只覆盖 Anthropic 协议的最大输出 token 数，协议、基址、密钥等配置要求可在后续变更中补充到此 capability。

## ADDED Requirements

### Requirement: Anthropic 服务可配置最大输出 token 数
系统 SHALL 允许 Anthropic 协议的模型服务保存一个可选的"最大输出 token 数"，并在向该服务发起聊天请求时将其作为请求的输出上限。未配置时，系统 MUST 使用 4096。

#### Scenario: 使用已配置的值
- **WHEN** 用户为 Anthropic 服务保存最大输出 token 数 8192，并向该服务发送消息
- **THEN** 发往上游的请求中输出上限为 8192

#### Scenario: 未配置时沿用默认值
- **WHEN** 用户向一个没有配置最大输出 token 数的 Anthropic 服务发送消息
- **THEN** 发往上游的请求中输出上限为 4096

#### Scenario: 清除已配置的值
- **WHEN** 用户把已保存的最大输出 token 数清空并保存
- **THEN** 该服务此后的请求使用 4096

### Requirement: OpenAI 兼容服务不受该设置影响
系统 SHALL 只对 Anthropic 协议的服务应用最大输出 token 数。OpenAI 兼容协议的服务 MUST NOT 保存该值，其请求内容 MUST 与本变更前一致。

#### Scenario: 切换协议后丢弃该值
- **WHEN** 用户把已配置最大输出 token 数的 Anthropic 服务改为 OpenAI 兼容协议并保存
- **THEN** 该服务不再保存最大输出 token 数

#### Scenario: OpenAI 请求不变
- **WHEN** 用户向 OpenAI 兼容服务发送消息
- **THEN** 请求体中不包含由该设置产生的输出上限字段

### Requirement: 最大输出 token 数必须是有效的正整数
系统 SHALL 在保存服务时校验最大输出 token 数：留空表示使用默认值，非空时 MUST 是 1 到 200000 之间的整数。不合法时系统 MUST 拒绝保存、给出中文错误提示，并保持原有配置不变。

#### Scenario: 拒绝非法取值
- **WHEN** 用户填写 0、负数、小数、非数字或大于 200000 的值并保存
- **THEN** 保存失败并显示错误提示，已保存的服务配置没有变化

#### Scenario: 接受边界值
- **WHEN** 用户填写 1 或 200000 并保存
- **THEN** 保存成功

### Requirement: 设置面板按协议显示该字段
设置面板的服务编辑表单 SHALL 在协议为 Anthropic 时显示"最大输出 token 数"输入框，并预填已保存的值；协议为 OpenAI 兼容时 MUST 隐藏该输入框。输入框为空时 SHALL 向用户说明将使用默认值 4096。

#### Scenario: 编辑已有 Anthropic 服务
- **WHEN** 用户打开一个已配置最大输出 token 数的 Anthropic 服务
- **THEN** 输入框显示已保存的值

#### Scenario: 切换协议时显示或隐藏
- **WHEN** 用户在表单中把协议从 Anthropic 切换为 OpenAI 兼容
- **THEN** 最大输出 token 数输入框消失

### Requirement: 设置在重启和旧数据升级后保持有效
系统 SHALL 在重启后保留已保存的最大输出 token 数。升级前创建的本地数据 MUST 在启动时自动升级，已有服务的数据和行为 MUST 保持不变，并按未配置处理。

#### Scenario: 重启后恢复
- **WHEN** 用户保存最大输出 token 数后退出并重新打开应用
- **THEN** 该服务仍使用保存的值

#### Scenario: 旧版本数据升级
- **WHEN** 应用打开一份由本变更之前的版本创建的本地数据，其中包含 Anthropic 服务
- **THEN** 该服务、历史对话和设置全部保留，且请求仍使用 4096

### Requirement: 修改该设置不使连接测试结果失效
系统 SHALL 在仅修改最大输出 token 数时保留该服务已有的文字和工具连接测试结果。连接测试 MUST 使用服务当前保存的最大输出 token 数发起请求。

#### Scenario: 仅修改输出上限
- **WHEN** 用户把一个已通过文字测试的服务的最大输出 token 数从 4096 改为 8192 并保存
- **THEN** 该服务的文字测试状态仍为"已验证"

#### Scenario: 测试使用已保存的值
- **WHEN** 用户保存最大输出 token 数 8192 后运行连接测试
- **THEN** 测试请求中的输出上限为 8192
