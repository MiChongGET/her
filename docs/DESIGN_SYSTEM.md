# Her - AI 助手应用设计规范

## 项目概述

Her 是一个优雅的桌面 AI 助手应用，采用 Electron + React + TypeScript 构建。设计语言融合东方美学与现代极简主义，以柔和的绿色调为主，营造舒适的对话氛围。

## 设计哲学

### 核心原则
- **东方美学**：宋体标题字体，柔和的自然色调
- **呼吸感**：充足的留白和间距，让内容自然呼吸
- **细节精致**：微妙的阴影、边框和过渡动画
- **层次清晰**：通过颜色深浅和视觉重量建立信息层级

## 色彩系统

### 主色调
```css
/* 品牌色 - 自然绿 */
--accent: #8fa375;
--accent-dark: #7b8f66;
--accent-light: #a1b589;

/* 背景色 - 温暖中性 */
--bg-primary: #fbfbf7;
--bg-gradient-start: #fbfbf7;
--bg-gradient-end: #f9f8f5;
--bg-surface: #fdfdf9;

/* 文字颜色 */
--text-primary: #2a3226;      /* 主要文字 */
--text-secondary: #3d4836;    /* 次要文字 */
--text-tertiary: #4f5a45;     /* 辅助文字 */
--text-meta: #5a6750;         /* 元信息 */
--text-hint: #6f7966;         /* 提示文字 */
--text-placeholder: #7d8773;  /* 占位文字 */

/* 边框颜色 */
--border-light: #e8e6dd;
--border-medium: #d9dfc9;
--border-strong: #c9d3b8;
--border-focus: #b7c0a7;
```

### 消息气泡配色
```css
/* 用户消息 - 清新绿 */
--user-bg: #d8e5c9;
--user-border: #c9dbb5;
--user-text: #2a3226;

/* 助手消息 - 纯净暖白 */
--assistant-bg: #f4f3ed;
--assistant-border: #e8e6dd;
--assistant-text: #2a3226;
```

### 状态颜色
```css
/* 危险/删除 */
--danger: #a67153;
--danger-light: #c9af9b;
--danger-bg: #faf6f2;

/* 警告 */
--warning: #8a4f3a;

/* 成功 */
--success: #7b8f66;
```

## 排版系统

### 字体族
```css
/* 中文标题 - 宋体 */
font-family: "Songti SC", "STSong", serif;

/* 界面文字 - 系统无衬线 */
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", sans-serif;

/* 代码字体 - 等宽 */
font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace;
```

### 字号阶梯
```css
--text-xs: 11px;    /* 小标签 */
--text-sm: 12px;    /* 辅助信息 */
--text-base: 14px;  /* 基础文字 */
--text-md: 14.5px;  /* 消息正文 */
--text-lg: 15px;    /* 强调文字 */
--text-xl: 16px;    /* 小标题 */
--text-2xl: 20px;   /* 标题 */
--text-3xl: 26px;   /* 大标题 */
```

### 行高
```css
--leading-tight: 1.4;
--leading-snug: 1.6;
--leading-normal: 1.7;
--leading-relaxed: 1.85;
--leading-loose: 1.95;
```

## 间距系统

### 标准间距
```css
--space-xs: 4px;
--space-sm: 8px;
--space-md: 12px;
--space-lg: 16px;
--space-xl: 20px;
--space-2xl: 28px;
--space-3xl: 40px;
```

### 组件间距
- 消息间距：28px
- 区块间距：20px
- 元素内边距：12px-16px
- 容器边距：40px（桌面）/ 20px（移动）

## 圆角系统

```css
--radius-sm: 4px;    /* 小元素：标签、徽章 */
--radius-md: 6px;    /* 按钮 */
--radius-lg: 12px;   /* 卡片、输入框 */
--radius-xl: 16px;   /* 消息气泡 */
--radius-2xl: 20px;  /* 大容器 */
--radius-full: 50%;  /* 圆形：头像 */
```

## 阴影系统

```css
/* 微妙阴影 - 用于消息气泡 */
box-shadow: 
  0 1px 3px rgba(75, 87, 58, 0.06),
  0 1px 2px rgba(75, 87, 58, 0.04);

/* 中等阴影 - 用于输入框 */
box-shadow: 
  0 2px 8px rgba(75, 87, 58, 0.04),
  0 1px 3px rgba(75, 87, 58, 0.08);

/* 聚焦阴影 */
box-shadow: 
  0 0 0 3px rgba(183, 192, 167, 0.12),
  0 2px 8px rgba(75, 87, 58, 0.08);

/* 浮动阴影 - 用于头像 */
box-shadow: 0 2px 6px rgba(75, 87, 58, 0.1);
```

## 组件规范

### 消息气泡

#### 用户消息
```css
.message.user .bubble {
  background: #d8e5c9;
  border: 1px solid #c9dbb5;
  border-radius: 16px 16px 4px 16px;
  padding: 12px 16px;
  box-shadow: 0 1px 3px rgba(75, 87, 58, 0.06),
              0 1px 2px rgba(75, 87, 58, 0.04);
  font-size: 14.5px;
  line-height: 1.85;
  color: #2a3226;
}
```

#### 助手消息
```css
.message.assistant .bubble {
  background: #f4f3ed;
  border: 1px solid #e8e6dd;
  border-radius: 16px 16px 16px 4px;
  padding: 12px 16px;
  box-shadow: 0 1px 3px rgba(75, 87, 58, 0.06),
              0 1px 2px rgba(75, 87, 58, 0.04);
}
```

### 输入框

```css
.composer {
  border: 1px solid #d9dfc9;
  border-radius: 12px;
  padding: 16px 17px 11px;
  background: #fdfdf9;
  box-shadow: 0 2px 8px rgba(75, 87, 58, 0.04),
              0 1px 3px rgba(75, 87, 58, 0.08);
  transition: border-color 0.2s, box-shadow 0.2s;
}

.composer:focus-within {
  border-color: #b7c0a7;
  box-shadow: 0 0 0 3px rgba(183, 192, 167, 0.12),
              0 2px 8px rgba(75, 87, 58, 0.08);
}

.composer textarea {
  font-size: 14.5px;
  line-height: 1.85;
  color: #3d4836;
}
```

### 按钮

#### 主按钮
```css
.primary-button {
  background: var(--accent);
  color: #f3f5ed;
  border: none;
  border-radius: 7px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s;
}

.primary-button:hover {
  background: var(--accent-dark);
}
```

#### 次要按钮
```css
.secondary-button {
  background: transparent;
  color: #5d7150;
  border: 1px solid #dce3d0;
  border-radius: 7px;
  padding: 8px 14px;
  font-size: 13px;
  transition: all 0.15s;
}

.secondary-button:hover {
  background: #f9faf6;
  border-color: #c9d3b8;
}
```

#### 危险按钮
```css
.danger-button {
  background: #a67153;
  color: #faf6f2;
  border: none;
  border-radius: 7px;
  padding: 8px 14px;
  font-size: 13px;
  transition: background 0.15s;
}

.danger-button:hover {
  background: #8e5d44;
}
```

### 表单元素

#### 输入框
```css
.field input {
  background: #fcfdf8;
  border: 1px solid #dce3d0;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  color: #4f5a45;
  transition: all 0.15s;
}

.field input:hover {
  background: #f9faf6;
  border-color: #c9d3b8;
}

.field input:focus {
  background: #fdfdf9;
  border-color: #b7c0a7;
  box-shadow: 0 0 0 2px rgba(183, 192, 167, 0.12);
}
```

#### 下拉列表
```css
.field select {
  background: #fcfdf8;
  border: 1px solid #dce3d0;
  border-radius: 8px;
  padding: 10px 32px 10px 12px;
  font-size: 13px;
  font-weight: 500;
  color: #4f5a45;
  appearance: none;
  background-image: url("data:image/svg+xml,...");
  background-position: right 10px center;
  background-repeat: no-repeat;
  transition: all 0.15s;
}
```

### Markdown 样式

#### 代码块
```css
.markdown pre {
  background: #2a3226;
  border: 1px solid #3d4836;
  border-radius: 8px;
  padding: 14px 16px;
  margin: 14px 0;
  overflow-x: auto;
  box-shadow: 0 2px 4px rgba(42, 50, 38, 0.1);
}

.markdown code {
  color: #e8ebe2;
  font-size: 13px;
  line-height: 1.7;
}
```

#### 内联代码
```css
.markdown code {
  background: #eef0e8;
  border: 1px solid #dce3d0;
  border-radius: 4px;
  padding: 2px 5px;
  color: #4a5440;
  font-size: 12px;
}
```

#### 引用块
```css
.markdown blockquote {
  background: #f7f8f4;
  border-left: 3px solid #b4c59f;
  border-radius: 0 4px 4px 0;
  padding: 10px 14px;
  margin: 12px 0;
  color: #4f5a45;
}
```

## 动画与过渡

### 标准过渡时长
```css
--duration-fast: 0.1s;     /* 即时反馈 */
--duration-base: 0.15s;    /* 按钮、输入框 */
--duration-slow: 0.2s;     /* 面板、对话框 */
--duration-slower: 0.3s;   /* 页面切换 */
```

### 缓动函数
```css
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
--ease-out: cubic-bezier(0, 0, 0.2, 1);
--ease-in: cubic-bezier(0.4, 0, 1, 1);
```

### 常用动画

#### 淡入淡出
```css
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

#### 呼吸效果（思考指示器）
```css
@keyframes breathe {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}
```

## 响应式设计

### 断点
```css
--breakpoint-mobile: 768px;
--breakpoint-tablet: 1024px;
--breakpoint-desktop: 1440px;
```

### 移动端适配
- 减少水平边距至 20px
- 头像尺寸保持 32px
- 消息气泡圆角保持 16px
- 按钮最小触摸区域 44px

## 可访问性

### 对比度
- 主要文字对比度 ≥ 7:1（AAA 级）
- 辅助文字对比度 ≥ 4.5:1（AA 级）
- 交互元素对比度 ≥ 3:1

### 聚焦状态
- 所有可交互元素必须有清晰的聚焦环
- 聚焦环颜色：rgba(183, 192, 167, 0.5)
- 聚焦环宽度：3px
- 聚焦环偏移：4px（outline-offset）

### 键盘导航
- Tab 键顺序符合视觉顺序
- Enter/Space 激活按钮
- Esc 关闭对话框/面板

## 开发指南

### CSS 组织原则
1. **使用 CSS 变量**：所有颜色、间距、圆角统一使用变量
2. **BEM 命名**：组件使用 `.component__element--modifier` 格式
3. **避免深层嵌套**：选择器层级不超过 3 层
4. **移动优先**：基础样式为移动端，通过媒体查询扩展

### 组件开发检查清单
- [ ] 响应式适配（移动端、平板、桌面）
- [ ] 深色模式支持（如需要）
- [ ] 键盘导航支持
- [ ] 聚焦状态可见
- [ ] 触摸区域足够大（≥ 44px）
- [ ] 颜色对比度符合 WCAG AA 标准
- [ ] 过渡动画流畅（0.15s-0.2s）
- [ ] 边界情况处理（空状态、错误状态）

## 设计资源

### 参考
- 东方美学：宋体字形、自然色调、留白艺术
- 现代极简：扁平化、微妙阴影、清晰层级
- 对话式界面：微信、iMessage、Telegram

### 工具推荐
- 颜色工具：https://coolors.co
- 对比度检查：https://webaim.org/resources/contrastchecker
- 字体配对：https://fontpair.co

## 更新日志

### 2024-10-14
- 初始版本创建
- 定义完整色彩系统
- 规范化排版和间距
- 优化消息气泡和输入框设计
- 统一表单元素样式
- 改进 Markdown 渲染样式
