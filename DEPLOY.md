# 部署你自己的 DSH 手机端（服务端指南）

本指南面向**想要拥有自己的 DSH 手机端**的人：照着做，你就能获得
「手机 App → 固定域名 → 你自己的电脑 → DSH」的完整链路。
费用：0 元（免费域名 + 免费隧道）。预计耗时：30~60 分钟。

---

## 一、前置环境（Windows 电脑）

1. **Node.js 18+**：https://nodejs.org 下载安装；
2. **DSH**：命令行执行 `npm i -g @deepseek-ai/dsh`；
3. **cloudflared**：`winget install cloudflare.cloudflared`（隧道客户端）。

## 二、获取本项目文件

需要两份东西：本仓库的 `app-android/`（手机 App 源码，GitHub Actions 自动构建 APK）
和服务端组件（`plugin/` 插件 + `tools/` 脚本）。

```
本项目根目录
├── plugin/                 # DSH 插件：认证代理 + /mobile 手机界面
├── tools/                  # 启动脚本 + 配置模板
└── app-android/            # 手机 App（构建出 APK 后安装）
```

## 三、注册免费域名（DNSHE）

1. 打开 https://www.dnshe.com 注册账号（邮箱即可）；
2. 进入 **Domain Hub**，注册一个子域名，如 `mydsh.de5.net`（后缀选 `.de5.net` 等）；
3. 进入 **API 管理**，创建 API 密钥，得到 `API Key`（`cfsd_` 开头）和 `API Secret`。

## 四、配置

1. 复制 `tools/dsh-config.example.txt` 为 `tools/dsh-config.txt`，填入：
   - `DOMAIN`：你的子域名（如 `mydsh.de5.net`）
   - `SUBDOMAIN_ID`：DNSHE 控制台里该子域名的 ID
   - `DNSHE_KEY` / `DNSHE_SECRET`：上一步的 API 密钥
2. 编辑 `plugin/cordis.patch.yml`，把 `user` / `password` 改成**你自己的登录凭证**
   （手机 App 登录时要用，请记好；不要把密码提交到公开仓库）。

## 五、安装插件到 DSH

1. 把 `plugin/` 目录复制到电脑某处，如 `C:\dsh-plugin-dev`；
2. 在命令行执行：

   ```
   dsh plugin --profile web add file:C:\dsh-plugin-dev
   ```

3. 首次启动会下载插件依赖；之后启动方式不变：

   ```
   dsh web
   ```

## 六、一键启动（以后每天就这一步）

双击 `tools/start-dsh.ps1`。它自动完成：

- 启动 `dsh web`（如未运行）；
- 启动 cloudflared 快速隧道；
- 隧道域名一变，自动通过 DNSHE API 把你的固定域名 `mydsh.de5.net`
  指向最新隧道 → **手机永远访问固定域名，无需改配置**。

> 首次运行时，脚本需要一点时间等隧道就绪；看到
> `PHONE URL: https://mydsh.de5.net/mobile` 即成功。

## 七、手机端

1. 构建 APK（见 `app-android/README.md`，GitHub Actions 自动构建）；
2. 手机安装 APK；
3. 打开 App，设置里填：
   - 服务器地址：`mydsh.de5.net`（自动发现模式）或完整地址 `https://xxx.trycloudflare.com/mobile`
   - 用户名 / 密码：你在 `cordis.patch.yml` 里设置的凭证
4. 保存即连。此后打开 App 直接进入 DSH，审批弹窗、模型选择、深色模式全可用。

## 安全须知

- **密码即边界**：`cordis.patch.yml` 里的 `user/password` 是唯一认证，
  请设强密码，**不要**提交到公开仓库；
- **`tools/dsh-config.txt`** 含 DNSHE API 密钥，已在 `.gitignore` 中排除，勿提交；
- 远程访问下，DSH 的 16 个特权方法（设置/凭据修改等）被官方锁死（403），属设计如此；
- 免费隧道带宽有限，打开超大会话会稍慢，属正常现象。

## 故障排查

| 现象 | 处理 |
|---|---|
| 手机提示"连接失败" | 电脑上 `dsh web` 是否在运行？`start-dsh.ps1` 是否打印了 PHONE URL？ |
| 域名打不开 | 等 1~2 分钟 DNS 生效；或重启 `start-dsh.ps1` 强制同步 |
| App 自动发现失败 | 检查 `dsh-config.txt` 的 `DOMAIN` 是否正确；改填完整地址临时使用 |
| 发送消息无响应 | 隧道断开，重启 `start-dsh.ps1`（会自动重连） |
