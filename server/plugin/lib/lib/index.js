// dsh-plugin-mobile-remote — DeepSeek Harness 手机远程控制
// 组件：browse 目录选择器注入（cordis.patch.yml）+ 内嵌认证代理 + cloudflared 隧道 + 二维码
// 原理：DSH 官方禁止绑定 0.0.0.0（RCE 风险）且 trustedHosts 不是认证层；
//       本插件的认证代理是唯一认证边界（密码 → 转发 → 127.0.0.1:3080）。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createAuthProxy } from './proxy.js'
import { printQr } from './qr.js'

export const name = 'mobile-remote'

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 认证代理监听端口（对外） */
  proxyPort: z.number().default(8082),
  /** 转发目标（DSH web 实际监听地址） */
  upstreamPort: z.number().default(3080),  // DSH web 默认端口 3080
  /** 启用 cloudflared 隧道（需要外部安装 cloudflared） */
  tunnelEnabled: z.boolean().default(true),
  /** cloudflared 可执行文件路径；缺省时从 PATH 探测 */
  cloudflaredPath: z.string().optional(),
  /** 密码文件路径；缺省 ~/.dsh/mobile-remote.auth */
  passwordFile: z.string().optional(),
  /** 固定用户名（缺省 dsh）；与 password 成对出现时使用固定凭证 */
  user: z.string().optional(),
  /** 固定密码（自定义后不再自动生成；一个凭证 = 一个账户） */
  password: z.string().optional(),
})

function defaultPasswordFile() {
  return join(homedir(), '.dsh', 'mobile-remote.auth')
}

function loadOrCreatePassword(file) {
  if (existsSync(file)) {
    const pw = readFileSync(file, 'utf8').trim()
    if (pw) return pw
  }
  const pw = randomBytes(9).toString('base64url')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, pw, { mode: 0o600 })
  return pw
}

function findCloudflared(explicit) {
  if (explicit) return explicit
  const { PATH } = process.env
  const candidates = PATH.split(';').filter(Boolean)
  const names = ['cloudflared.exe', 'cloudflared']
  for (const dir of candidates) {
    for (const n of names) {
      const p = join(dir, n)
      if (existsSync(p)) return p
    }
  }
  // winget 安装位置兜底
  const winGet = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
  return existsSync(winGet) ? winGet : null
}

export function apply(ctx, config) {
  if (!config.enabled) return
  const passwordFile = config.passwordFile ?? defaultPasswordFile()
  // 固定凭证优先（用户自定义 user/password），否则读文件/自动生成
  const user = config.user ?? 'dsh'
  const password = config.password ?? loadOrCreatePassword(passwordFile)

  let proxyServer = null
  let tunnelProc = null

  const log = (...args) => {
    const line = args.join(' ')
    try { ctx.logger?.info?.(line) } catch {}
    console.log('[mobile-remote] ' + line)
  }

  ctx.effect(() => {
    // ── 1) 认证代理（同进程内嵌 HTTP 服务器）──
    try {
      proxyServer = createAuthProxy({
        port: config.proxyPort,
        upstreamPort: config.upstreamPort,
        user,
        password,
        onLog: (line) => console.log('[mobile-remote] ' + line),
      })
      log(`认证代理已启动：0.0.0.0:${config.proxyPort} → 127.0.0.1:${config.upstreamPort}（凭证：${user}/${password}）`)
    } catch (e) {
      log(`认证代理启动失败：${e.message}`)
      proxyServer = null
    }

    // ── 2) cloudflared 隧道 ──
    if (config.tunnelEnabled) {
      const cf = findCloudflared(config.cloudflaredPath)
      if (cf) {
        try {
          tunnelProc = spawn(cf, ['tunnel', '--url', `http://127.0.0.1:${config.proxyPort}`], { stdio: ['ignore', 'pipe', 'pipe'] })
          let url = null
          // cloudflared 的日志（含 trycloudflare URL）输出在 stderr；stdout 无输出
          const onText = (text) => {
            const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
            if (m && !url) {
              url = m[0] + '/mobile'
              log(`隧道已就绪（手机端）：${url}`)
              log(`凭证：${user}/${password}（可在插件配置中修改，见 README）`)
              printQr(url, log)
            }
            if (text.includes('ERR')) log('隧道: ' + text.trim().split('\n')[0])
          }
          tunnelProc.stderr.on('data', (buf) => onText(buf.toString()))
          tunnelProc.on('exit', (code) => log(`隧道进程退出（code ${code}）`))
        } catch (e) {
          log(`隧道启动失败：${e.message}`)
        }
      } else {
        log('未找到 cloudflared——跳过隧道。安装：winget install cloudflare.cloudflared（或自行安装后配置 cloudflaredPath）')
      }
    }

    return () => {
      tunnelProc?.kill()
      proxyServer?.close()
      log('已停止（认证代理与隧道已关闭）')
    }
  }, 'mobile-remote: 认证代理与隧道')
}
