# dsh-video-preview

[English](./README.md) | **中文**

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 侧边栏文件预览提供**流式**视频预览。在文件面板里打开 `mp4`、`webm`、`mov` 或 Ogg 视频即可直接播放并拖动进度，而不是看到「无法预览此文件」。

## 为什么用流式，而不是读字节

文档预览给渲染器提供了三种取数方式。最直观的 `bytes-complete` 会把整个文件交给渲染器，但对视频来说这是错的：

- **它有上限。** `workspaceFiles` 的完整文件读取受 `maxFileBytes` 限制（默认 32 MiB），超限会**直接拒绝且不截断**，所以任何真实视频都看不了。
- **要等全部下载完才出画面。** 第一帧得等整个文件到位。
- **拖动进度会重读。** 播放器必须在内存里持有整个文件才能跳到某个时间点。

因此本插件改用 `renderer` 模式：文档体自己负责取数，把浏览器的 `<video>` 元素指向一条支持 `Range` 的 HTTP 路由。剩下的交给浏览器——它本来就擅长这些：先取一点就开始播放，跳转时只按需请求对应区间。无论文件多大，内存占用都保持平稳。

## 支持的格式

| 后缀 | 媒体类型 | 说明 |
|---|---|---|
| `.mp4` | `video/mp4` | H.264/AAC 是最稳妥的组合 |
| `.m4v` | `video/mp4` | |
| `.webm` | `video/webm` | VP8/VP9/AV1 + Opus/Vorbis |
| `.mov` | `video/quicktime` | 携带浏览器支持的编码时可播放 |
| `.ogv` | `video/ogg` | |
| `.ogg` | `video/ogg` | |

浏览器解不了的容器**刻意不认领**：`mkv`、`avi`、`wmv`、`flv` 保持原有的「无法预览」状态。认领它们只会把一句诚实的提示换成永远报错的播放器。

## 安装

把 `dsh-video-preview/` 目录作为一个 bundle 装进你的 DSH profile —— 对 DSH agent 而言，就是用 `plugin_manager` 工具的 `install_bundle` 动作指向本目录。bundle 补丁会插入一行插件配置，因此改动**无需重启即刻生效**，并且在下次重启后依然保留。作用范围是单个 profile。

本 bundle **零运行时依赖**、无构建步骤，安装过程不会访问 npm registry。

## 工作原理

两个半边，由一条路由连接。

**Host 半边**（`index.js`）注册一条 exact 路由 `/dsh-media/video`：

```
GET /dsh-media/video?path=<绝对路径>
Range: bytes=<start>-<end>
```

返回 `200`（整个文件）、`206`（请求区间，带 `Content-Range`）、`416`（区间不可满足）以及 `HEAD`。字节通过组合文件系统（`ctx.fs`）读取 —— 与 `workspaceFiles` 相同的读取权限 —— 按 `chunkBytes` 分窗读取、带背压写出，客户端跳转或断开时立即中止读取。

**Client 半边**（`client.js`）只通过文档预览的公开扩展点做两处注册：

1. 一个 `DocumentPreviewDefinition` 认领上表后缀，使视频文件选中本实现；
2. 它在 `sidebar.right.tab.document` 槽位中的 keyed 文档体。

文档体通过标准 `useResource` hook 解析出文件绝对路径，再把流式 URL 交给 `<video>` 元素；URL 作为 key，因此文件版本变化或手动刷新都会干净地重新挂载。它会向 owner 回报 `loaded`/`failed`，从而让工具栏的刷新按钮与变更追踪保持正确。

## 安全性

这条路由**不是**未认证的文件服务器。每个请求在解析任何路径之前，都要先经浏览器连接载体（`ctx.connection.requestRejection`）准入：请求必须到达回环或已配置的可信 Host、携带已签名的浏览器会话 Cookie，且不能是跨站请求。被拒绝的请求完全不碰文件系统。在此之上，路由还要求绝对路径且后缀在上表之内，否则在尝试读取前就返回 `400`/`415`。

## 配置

在 `cordis.patch.yml` 的插件行上设置：

```yaml
- id: dsh-video-preview
  name: '@local/dsh-video-preview'
  config:
    chunkBytes: 4194304   # 每次流式读取的字节数，默认 1048576（1 MiB）
```

`chunkBytes` 只限制每次读取占用的内存，与可流式传输的文件大小无关。

## 测试

不需要测试框架；都是直接跑在真实 HTTP 服务器、真实文件系统与真实媒体字节上的脚本。需要 `ffmpeg` 与 `ffprobe` —— 样例视频按需生成，不纳入版本库。

```bash
node verify/route.test.js     # 17 项：准入、校验、HTTP/Range 契约、中断恢复
node verify/stream.test.js    #  6 项：字节一致性与可解码性
node verify/failure.test.js   #  2 项：错误路径干净收尾
```

其中 `stream.test.js` 最有价值：它把 64 KiB 的区间响应重新拼成与源文件**逐字节一致**的一份拷贝，再用 `ffprobe` 校验拼接结果仍然报告源文件自己的编码、分辨率与时长 —— 这证明浏览器在流中来回跳转拿到的确实是合法视频，而不只是「看起来像那么回事」的字节。

## 目录结构

```
dsh-video-preview/   可安装的 bundle
  package.json       清单：dsh.bundle.patch + dsh.client
  cordis.patch.yml   插入插件行
  index.js           Host 半边 —— 流式媒体路由
  client.js          Client 半边 —— 预览定义与视频文档体
  locale/            插件管理页展示信息（中、英）
verify/              测试套件与共享 harness
```

## 已知限制

- 浏览器无法解码的视频按设计保持不可预览（见上文）。
- 只有当文件系统后端能报告文件大小时，`Range` 请求才能被满足；否则路由退化为普通 `200` 流，可播放但无法拖动进度。
- 结构上仅限同源：路由相对于当前文档解析，且连接载体本身会拒绝跨站请求。

## 许可证

[MIT](./LICENSE)
