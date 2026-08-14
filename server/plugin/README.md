# dsh-plugin-mobile-remote

让手机（安卓 / 苹果 / 鸿蒙）随时随地安全地指挥电脑上的 DeepSeek Harness（DSH）。一条命令安装，扫码即用。

## 快速开始

```bash
# 1. 安装插件
npx @deepseek-ai/dsh plugin --profile web add <包名>

# 2. 启动 DSH（DSH 默认端口 3080 = 插件 upstreamPort；trusted-host 用固定内部域名 dsh.remote）
npx @deepseek-ai/dsh web --trusted-host dsh.remote
```

启动后插件自动完成三件事（日志可见）：

```
[mobile-remote] 认证代理已启动：0.0.0.0:8082 → 127.0.0.1:3080（密码：xxxxx）
[mobile-remote] 隧道已就绪：https://xxxx.trycloudflare.com（手机浏览器打开，输密码 xxxxx）
[mobile-remote] 手机扫码直达：[二维码]
```

手机浏览器打开隧道 URL → 输密码 → 完整操作 DSH（工作区、会话、文件浏览全可用）。

## 独立移动端 UI（/mobile）

除官方桌面 UI 的移动适配外，插件自带**独立移动端界面**（`/mobile`，扫码后手机默认落地页），零依赖原生实现（HTML/CSS/JS，无框架）：

- **工作区 → 会话 → 聊天**三级导航；新建会话、会话标题/运行中状态、相对时间
- **聊天**：用户/AI 气泡（DeepSeek 设计语言：22px 圆角、16px/24px 字号）、深度思考折叠块、工具调用行（可展开参数/结果）、流式增量渲染、自动轮询刷新（运行中 2s / 空闲 4s）
- **发送/停止生成**、模型选择底部抽屉（provider 分组 + 思考强度）、暗色模式、系统上下文注入过滤
- 安全边界与主路径一致：Basic Auth 密码 → 认证代理 → DSH RPC（`POST /api/<method>`，`client-request` 格式）

静态文件每请求读盘：直接替换 `lib/mobile/` 下的文件即生效，无需重装插件。

## 原理

```
手机浏览器 (PWA) → HTTPS 隧道 (cloudflared) → 认证代理 (插件内嵌, 密码校验) → DSH web (127.0.0.1:3080)
```

为什么需要这三层（都是官方约束逼出来的）：

| 官方约束 | 我们的对策 |
|---|---|
| DSH 禁止绑定 0.0.0.0（官方安全设计，防止 RCE 暴露到网络） | 认证代理监听对外端口，DSH 保持 127.0.0.1 |
| `trustedHosts` 明确**不是认证层**——任何拿到 URL 的人都能执行 shell | 认证代理是唯一认证边界：Basic Auth 密码校验（`timingSafeEqual` 防时序攻击） |
| 原生目录选择器（`pickDirectory`）锁 loopback，远程一律 403 | 插件自动注入 **browse** 目录选择器（`listDirectory` API，远程可用）——无需手动改配置 |
| 浏览器信任围栏校验 Host/Origin 一致性 | 认证代理统一改写 Host/Origin 为固定内部域名 `dsh.remote`，DSH 端 `--trusted-host dsh.remote` 一次配置，隧道域名怎么变都不受影响 |

## 安全说明（重要）

- **密码即边界**：认证代理是唯一入口，未认证一律 401。密码自动生成，存于 `~/.dsh/mobile-remote.auth`（0600 权限），可自行修改
- **隧道是临时域名**：trycloudflare 临时隧道每次重启变化。正式使用建议配置固定域名隧道（Cloudflare named tunnel + 自有域名）或 Tailscale
- **DSH 的 16 个特权方法远程仍不可用**（settings/credentials/pickDirectory 等官方锁死，属预期）
- **明文 HTTP 不可行**：官方 UI 依赖 Web Crypto API（secure context），必须 HTTPS——这正是隧道的作用

## 配置项

插件配置通过 DSH 配置层（`cordis.patch.yml` 或 `--patch` 覆盖）：

```yaml
- id: mobile-remote
  name: '<包名>'
  config:
    proxyPort: 8082        # 认证代理对外端口
    upstreamPort: 3080     # DSH web 实际端口（DSH 默认 3080；DSH 换端口时同步改这里）
    tunnelEnabled: true    # 是否启动隧道
    passwordFile: ~        # 密码文件路径（缺省 ~/.dsh/mobile-remote.auth）
    cloudflaredPath: ~     # cloudflared 路径（缺省自动探测 PATH + winget 安装位）
```

## 依赖

- Node.js + DSH（`npx @deepseek-ai/dsh web`）
- cloudflared（隧道）：`winget install cloudflare.cloudflared` 或自行安装

## 踩坑记录（给维护者）

这些坑都来自真实排查，是文档级资产：

1. **`--host 0.0.0.0` 被官方硬拒绝**：DSH 启动器直接报错。远程访问只能走「代理 + 127.0.0.1」
2. **转发时改 Host 头 = 全部 /api 403**：认证代理最初把 Host 覆盖为 127.0.0.1，fence 的 Origin 检查（`new URL(origin).host === hostUrl.host`）失败。转发必须保留/统一改写 Host 与 Origin 成对出现
3. **auto 目录选择器的盲区**：`directory-picker-auto` 只看服务绑定判定（Windows + 127.0.0.1 → native），想不到浏览器在远程。远程场景必须固定 browse
4. **插件 patch 注入**：包通过 `package.json` 的 `dsh.bundle.patch` 声明自己的 patch 层，自动应用在 bundle 之后——用户零手动配置（微信插件需手动编辑 patch，本插件已消除）
5. **Cordis 插件配置校验**：Config 必须声明 zod 依赖（版本与 Cordis 兼容，^4.3.6），挂载行需带显式 config（否则 `expected object, received undefined`）
6. **pnpm file: 链接缓存**：本地开发改插件代码后必须 `rm` + `add` 重装，否则读旧代码
7. **cloudflared URL 在 stderr**：trycloudflare URL 输出在 stderr 流，不是 stdout
8. **`.env` 文件名冲突**：DSH 启动时会加载项目目录的 `.env` 并拒绝「启动环境级」变量——密码文件不要叫 `.env`
