# EditHere 安卓版（WebView 壳）

把仓库自带的离线单文件 Web 版（`web/EditHere.html`）包进原生 WebView，
页面零修改，靠注入 `bridge.js` 补齐移动端能力。个人非商用移植，
遵循仓库 PolyForm Noncommercial 1.0.0 许可与商标政策。

## 能力

- 打开素材：系统文件选择器（图片/视频/JSON 项目/ZIP），走页面原生 `<input type=file>`
- 导出：拦截页面 blob 下载，分块回传 Java，存入系统下载目录
- **移动端导出收口（0.3.0 起）**：只保留「意见图」，隐藏 导出反馈(JSON/ZIP)、
  保存 JSON、保存批注图；同时置空 `#export`/`#save-json` 的 onclick（否则隐藏节点被
  程序化点击会弹出看不见的模态框，挡住后续手势）。保留 保存项目（存档续改、
  返回键防丢依赖它）与 主题、帮助
- 意见图（壳内新增，页面零修改）：把批注后的原图（含圈画）贴到一张白底大画布上，
  下方按内容自适应扩充「修改意见」栏（编号圆点与图上序号对应，整组意见用「整 N」胶囊），
  导出 `*-notes.png`；入口在顶栏右上角（蓝色下载图标，窄屏只显示图标），字号/边距随原图尺寸等比，
  超过 2400 万像素等比缩小防 OOM
- 复制 JSON：`navigator.clipboard.writeText` 桥接到系统剪贴板（面板入口已隐藏，桥仍在）
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
## 返回键与安全

- 页面用 `beforeunload` 拦未保存退出，但 WebView 不触发；壳在已有素材时拦截返回键，
  弹出「保存项目 / 不保存退出 / 取消」。无素材时直接退出。
- `shouldOverrideUrlLoading` 仅放行 `file:///android_asset/`、`blob:`、`data:`、`javascript:`，
  其余导航一律拦截（桥接对象暴露了写文件能力，不能让外部页面调用）。
- API 26–28 写公共下载目录需 `WRITE_EXTERNAL_STORAGE` 运行时权限，首次保存会申请。

## 回归

`tests/regression.cjs`：playwright-core + CDP 真实多点触控，覆盖打开素材、框选/点/智能批注、
撤销重做、保存项目与重开、导出 JSON/剪贴板/批注图、组图、视频帧批注、帮助、捏合缩放、
双指平移、单指拖动中落第二指不串扰、360px 顶栏，共 39 项断言。
运行：`npm i playwright-core` 后 `node tests/regression.cjs`（需本机 Chromium）。

`tests/notes-image.cjs`：意见图单独验证（竖图 600×900 两条意见、横图 1200×675 一条、
1080×2400 八条含中英混排、无意见时导出带白边原图），把 `endFile` 的 base64 落地到
`/tmp/eh-notes-*.png` 供目视核对编号、换行与留白。
