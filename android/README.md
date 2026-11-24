# EditHere 安卓版（WebView 壳）

把仓库自带的离线单文件 Web 版（`web/EditHere.html`）包进原生 WebView，
页面零修改，靠注入 `bridge.js` 补齐移动端能力。个人非商用移植，
遵循仓库 PolyForm Noncommercial 1.0.0 许可与商标政策。

## 能力

- 打开素材：系统文件选择器（图片/视频/JSON 项目/ZIP），走页面原生 `<input type=file>`
- 导出：拦截页面 blob 下载，分块回传 Java，存入系统下载目录（JSON/ZIP/PNG/项目文件）
- 复制 JSON：`navigator.clipboard.writeText` 桥接到系统剪贴板
- 触控：单指批注/拖动沿用页面 Pointer Events；双指捏合翻译为 ctrl+wheel 缩放，
  双指拖动翻译为合成中键 pointer 事件平移（页面 pan 期间忽略 wheel，
  故每次捏合按「结束 pan → wheel → 重启 pan」序列执行）
- 零网络：页面 CSP 禁一切网络，壳不声明 INTERNET 权限

## 构建

依赖：JDK 17、Android SDK 34、Gradle 8.9（wrapper 已配）。

```bash
# 若改过 web/src，先重新打包单文件 HTML
node ../web/build.cjs
# 构建（syncWebHtml 任务会自动把 ../web/EditHere.html 同步进 assets）
./gradlew assembleDebug assembleRelease
```

release 签名读取 `keystore.properties`（指向 `keystore/edithere.jks`）。
两者均已 gitignore；本机缺失时 release 退回未签名，需自行补签名。

## 已知限制 / 下一步

- 小屏下批注侧栏仍按桌面宽度布局，后续可做抽屉式适配
- 导出目前落到下载目录，后续可加系统分享面板直达 AI/电脑
- AI 闭环（MCP/agent.cjs）保留在桌面侧：手机导出兼容 JSON，桌面 agent 读取继续改
- 快捷键（V/H/Ctrl+S 等）无实体键盘时不可用，后续可补浮动按钮