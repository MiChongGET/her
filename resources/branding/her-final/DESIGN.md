# her 与 Samantha · 选定 B 版

用户选择第三轮 B：将完整小写 her 融进对话图形。核心含义是“会记得你的私人伙伴”，陪伴与记忆为主，对话为辅。暖白与灰绿、Samantha 原创人物方向延续前面的选择。

## 本版精修

- 保留完整 h/e/r 的原创曲线与字间距。
- 书签顶部圆角为 2 个设计单位，V 形缺口使用轻微曲线过渡；保留与 r 的间距。
- 对话尾部收短约 5–6 个设计单位并圆润尖端。
- 应用图标将同一图形置于暖白圆角方底，保持宽高比例。

## 资源

| 文件 | 格式与尺寸 | 用途 |
| --- | --- | --- |
| her-logo.svg | 原生 SVG，384×256 viewBox | 透明底主标识，完整 her 为负形 |
| her-logo.png | 透明 PNG，1536×1024 | 主标识通用导出 |
| her-app-icon.svg | SVG，1024×1024 | 暖白圆角方底应用图标 |
| her-app-icon.png | PNG，1024×1024 | 应用图标导出 |
| her-app-icon.icns | macOS ICNS，16–1024px | 打包后的应用与 Dock 图标 |
| native-icons/her-tray.png、her-tray@2x.png | 透明 PNG，27×18 / 54×36 | 菜单栏模板图标与 Retina 版本 |
| her-logo-monochrome.svg | SVG，384×256 viewBox | 黑色单色标识 |
| her-logo-monochrome.png | 透明 PNG，1536×1024 | 单色标识导出 |
| samantha-avatar.png | PNG，1254×1254 | 人物头像，沿用第一轮插画 |
| preview.html | 本地 HTML | 品牌、人物、32/36/64px 使用示意 |

主 Logo 和单色版字母、书签区域均为真正透明负形；SVG 无字体依赖，PNG 由同一 SVG 导出。主色 #66765d，背景 #f8f7f3。头像使用内置 imagegen 生成，原始提示词与绘画风格修订见 [第一轮设计说明](../her-v1/DESIGN.md)。

应用已接入本目录的正式资源：启动页、标题栏与系统状态使用 Her Logo；侧栏和助手消息使用 Samantha 头像；macOS 打包指定 ICNS，开发 Dock 和菜单栏使用同版图标。渲染资源由 Vite 收集，原生托盘资源单独加入打包产物，设计预览与旧草案不进入应用。

## 接入验证（2026-10-24）

- `npm run check` 通过：类型检查、1335 项测试通过 / 4 项跳过、应用构建完成。
- 在隔离的 `HER_DATA_DIR` 中验证源码运行与 macOS 打包版：Logo 和两处头像均正常加载，1140×800 与 850×620 布局无重叠，头像保持圆形裁切。
- 原生托盘图像为 27×18，Electron 自动加载 1× / 2× 表示；包内 ICNS 和托盘 PNG 与正式源文件一致。
- 本地打包产物为 `release/Her-darwin-arm64/Her.app`；未替换或重启用户已运行的应用。
