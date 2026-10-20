# Spec Delta

## Purpose

定义任务的身份、状态与生命周期，包括会话内持久消息队列、停止与继续、窗口关闭与应用退出，以及重启后的恢复规则。

## ADDED Requirements

### Requirement: 任务状态明确可见
系统 SHALL 为每个任务维护以下状态之一：queued、running、waiting_approval、waiting_resource、compacting、retrying、stopping、completed、stopped、failed、interrupted，并在对应会话中展示。模型回答结束、工具成功与任务完成 MUST 分别判断。

#### Scenario: 等待审批
- **WHEN** 任务中的工具调用需要用户审批
- **THEN** 任务显示 waiting_approval，直到用户批准、拒绝或停止

#### Scenario: 模型回答结束但任务未结束
- **WHEN** 一次模型回答结束后 Agent 仍要继续调用工具
- **THEN** 任务保持 running，不显示 completed

### Requirement: 运行中提交的消息进入持久队列
任务运行中，用户在同一会话提交的消息 SHALL 按提交顺序进入该会话的持久队列，每条拥有独立请求身份。队列 MUST 可查看，未开始的条目 MUST 可撤销。系统 MUST NOT 把排队消息插入正在执行的任务。

#### Scenario: 查看并撤销排队消息
- **WHEN** 会话中有两条排队消息，用户撤销第一条
- **THEN** 第一条从队列移除且永远不会发送，第二条保留

#### Scenario: 同一消息不重复处理
- **WHEN** 一条排队消息被取出处理
- **THEN** 它只产生一个任务，不会被再次取出

### Requirement: 仅正常完成后自动处理下一条
当前任务以 completed 结束后，系统 SHALL 自动取出该会话的下一条排队消息并为其开始新任务。任务以 stopped、failed、interrupted 结束，或压缩失败、出现未知动作、会话进入回收站时，该会话队列 MUST 暂停，等待用户处理。

#### Scenario: 正常完成后继续
- **WHEN** 任务完成且队列中有一条消息
- **THEN** 系统自动以该消息开始新任务

#### Scenario: 停止后不偷跑
- **WHEN** 用户停止任务且队列中有消息
- **THEN** 队列暂停并显示可继续，排队消息不自动发送

### Requirement: 停止任务
用户 SHALL 可以停止任一运行中的任务。停止时系统 MUST 先阻止该任务继续派发工具和取出队列，取消其审批与资源等待，再中止模型请求或压缩；已派发工具的结果 MUST 被确认或登记为未知动作。已显示的部分文本 SHALL 保留并标为中断片段。

#### Scenario: 生成中停止
- **WHEN** 回答流式输出到一半时用户点击停止
- **THEN** 任务变为 stopped，已显示文字保留并标记为已中断

#### Scenario: 迟到结果不复活任务
- **WHEN** 任务停止后，一个已派发工具的结果才返回
- **THEN** 结果记录到审计中，但任务保持 stopped，模型不会继续生成

### Requirement: 关闭窗口时后台继续
关闭或最小化窗口时运行中的任务 SHALL 继续。重新打开窗口时，各会话的进度、队列和待审批项 SHALL 正确显示。切换会话列表选择 MUST NOT 停止任务。

#### Scenario: 关窗后重新打开
- **WHEN** 任务运行中用户关闭窗口，稍后重新打开
- **THEN** 窗口显示该任务的最新状态和已生成的内容

### Requirement: 退出应用停止全部任务
用户真正退出应用时，系统 MUST 先阻止新任务开始，再停止全部会话任务、保存状态并关闭 Her 拥有的资源与进程。结果未知的外部目标 MUST 保留隔离记录。

#### Scenario: 运行中退出
- **WHEN** 两个会话都有任务运行时用户退出应用
- **THEN** 两个任务都被停止并保存，Her 启动的子进程全部结束

### Requirement: 重启后只恢复记录不自动续跑
应用重启时系统 SHALL 恢复会话历史、队列和任务账本。上次未结束的任务 MUST 标为 interrupted；系统 MUST NOT 自动执行排队消息、重放工具或重新发送模型请求。

#### Scenario: 崩溃后重启
- **WHEN** 任务运行中应用崩溃，用户重新启动
- **THEN** 该任务显示为 interrupted，队列保持暂停，没有新的模型请求或工具调用发生

### Requirement: 用户明确继续中断的任务
用户 SHALL 可以对 interrupted、stopped 或 failed 的任务选择继续。继续 MUST 创建与原任务关联的新尝试，并保留原有的未知动作隔离和审批约束。

#### Scenario: 继续中断任务
- **WHEN** 用户对 interrupted 任务点击继续
- **THEN** 系统开始一个关联原任务的新尝试，原任务中结果未知的工具不会被自动重新执行
