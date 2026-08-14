// 认证代理（插件内嵌模块）：0.0.0.0:port → 127.0.0.1:upstreamPort
// 安全模型：
//   - 认证：Basic Auth 密码（timingSafeEqual）+ 失败限速（指数退避）
//   - Host/Origin 统一改写为 dsh.remote（DSH 端 --trusted-host dsh.remote）
//     ——隧道域名每次重启会变，改写后 DSH 端无需跟随更新；fence 只校验
//     Host/Origin 一致性。注意：改 Host 不改 Origin 会全部 403。
//   - 根路径 302 → /mobile（手机端只暴露自研移动 UI）
//   - WS 升级只放行 /api/events.{mux,host}（收窄转发面）
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { createGzip } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 固定内部域名：DSH 端需配置 --trusted-host dsh.remote（见 README） */
export const TRUSTED_HOST = 'dsh.remote'

/** 移动适配 CSS：注入到官方 UI 的 HTML 响应（media query 仅手机视口生效，桌面不受影响） */
const MOBILE_CSS = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'mobile-inject.css'), 'utf8')

/** 在 HTML 的 </head> 前注入移动适配样式（幂等：已有则跳过） */
function injectMobileCss(html) {
  if (!html.includes('<style data-dsh-mobile-remote>')) {
    return html.replace('</head>', `<style data-dsh-mobile-remote>${MOBILE_CSS}</style></head>`)
  }
  return html
}

/**
 * viewport meta 移动端修正（幂等）：
 * - viewport-fit=cover：刘海/手势条区域进入视口，CSS safe-area-inset 生效
 * - interactive-widget=resizes-content：Chrome 108+（含 Android WebView）软键盘弹出时
 *   收缩布局视口而非只缩视觉视口——否则 fixed/sticky 底栏被键盘盖住。
 *   旧版本浏览器忽略该 token，优雅降级。
 * 官方 HTML 已有 viewport meta 时替换之，避免重复 meta 取第一个失效。
 */
function injectViewportMeta(html) {
  if (html.includes('data-dsh-mobile-remote-viewport')) return html
  const meta = '<meta name="viewport" data-dsh-mobile-remote-viewport content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">'
  const replaced = html.replace(/<meta[^>]*name=["']viewport["'][^>]*>/i, meta)
  return replaced !== html ? replaced : html.replace('</head>', meta + '</head>')
}

export function createAuthProxy({ port, upstreamPort, user = 'dsh', password, onError = () => {} }) {
  const upstream = { host: '127.0.0.1', port: upstreamPort }

  // ── 暴力破解防护：失败计数 + 指数退避（按来源 IP） ──
  const failCount = new Map() // ip -> { count, lockedUntil }
  const FAIL_LIMIT = 5          // 连续失败次数
  const LOCK_BASE_MS = 10_000   // 首次锁定 10s，之后翻倍
  const LOCK_MAX_MS = 300_000   // 上限 5min

  function rateLimited(ip) {
    const rec = failCount.get(ip)
    if (!rec) return false
    if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true
    if (rec.lockedUntil && rec.lockedUntil <= Date.now()) failCount.delete(ip)
    return false
  }
  function recordFailure(ip) {
    const rec = failCount.get(ip) || { count: 0, lockedUntil: 0 }
    rec.count += 1
    if (rec.count >= FAIL_LIMIT) {
      const lock = Math.min(LOCK_BASE_MS * 2 ** (rec.count - FAIL_LIMIT), LOCK_MAX_MS)
      rec.lockedUntil = Date.now() + lock
      rec.count = 0
      onError(`IP ${ip} 认证失败过多，已锁定 ${Math.round(lock / 1000)}s（暴力破解防护）`)
    }
    failCount.set(ip, rec)
  }
  function recordSuccess(ip) { failCount.delete(ip) }
  // 定期清理过期记录，防 Map 无限增长
  setInterval(() => {
    const now = Date.now()
    for (const [ip, rec] of failCount) {
      if (rec.lockedUntil && rec.lockedUntil <= now) failCount.delete(ip)
    }
  }, 60_000).unref()

  function clientIp(req) {
    // cloudflared 在本机转发：拿真实来源需 cf-connecting-ip（Cloudflare 隧道附加）
    return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
  }

  function authorized(req) {
    const auth = req.headers['authorization'] ?? ''
    const m = auth.match(/^Basic\s+(.+)$/)
    if (!m) return false
    const decoded = Buffer.from(m[1], 'base64').toString('utf8')
    const expected = Buffer.from(`${user}:${password}`)
    const given = Buffer.from(decoded)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  const server = createServer((req, res) => {
    const ip = clientIp(req)
    if (rateLimited(ip)) {
      res.writeHead(429, { 'Retry-After': '60' })
      res.end('429 Too Many Requests')
      return
    }
    if (!authorized(req)) {
      recordFailure(ip)
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="DSH Remote"' })
      res.end('401 Unauthorized')
      return
    }
    recordSuccess(ip)
    // 旧移动端入口 /mobile → 官方 UI（自研移动 UI 已废弃：官方 UI + 适配 CSS 方案）
    if (req.url.startsWith('/mobile')) {
      res.writeHead(302, { location: '/' })
      res.end()
      return
    }
    // Host/Origin 统一改写为 loopback 形式：
    // 1) 隧道域名每次重启会变，改写后 DSH 端无需配置 trusted-host
    // 2) 官方把 settings/credentials 等特权方法锁 loopback——改写后远程也能
    //    正常保存设置（内测声明、模型配置等，否则弹窗无法关闭）
    // 安全模型：认证代理（密码）是唯一边界。能过密码的人本来就拥有
    //   会话执行权限（可运行 shell），故 loopback 伪装不扩大实际攻击面。
    const headers = {
      ...req.headers,
      host: `${upstream.host}:${upstream.port}`,
      ...(req.headers.origin ? { origin: `http://${upstream.host}:${upstream.port}` } : {}),
    }
    const proxy = httpRequest(
      { host: upstream.host, port: upstream.port, path: req.url, method: req.method, headers },
      (upRes) => {
        // HTML 响应：注入移动适配 CSS（buffering；其余流式转发）
        const upCtype = String(upRes.headers['content-type'] ?? '')
        if (upCtype.includes('text/html') && upRes.statusCode === 200) {
          let htmlBody = ''
          upRes.setEncoding('utf8')
          upRes.on('data', (chunk) => { htmlBody += chunk })
          upRes.on('end', () => {
            const patched = injectViewportMeta(injectMobileCss(htmlBody))
            const h = { ...upRes.headers }
            delete h['content-length']
            res.writeHead(upRes.statusCode, h)
            res.end(patched)
          })
          return
        }
        // 大 JSON/文本响应流式 gzip：手机端拉取大会话历史(可达数 GB)时传输量降为 5-10%
        const acceptGzip = /gzip/i.test(req.headers['accept-encoding'] ?? '')
        const ctype = upCtype
        const compress = acceptGzip && /json|text|javascript|xml/.test(ctype) && upRes.statusCode !== 204
        if (compress) {
          const h = { ...upRes.headers }
          delete h['content-length']
          h['content-encoding'] = 'gzip'
          res.writeHead(upRes.statusCode, h)
          upRes.pipe(createGzip()).pipe(res)
        } else {
          res.writeHead(upRes.statusCode, upRes.headers)
          upRes.pipe(res)
        }
      }
    )
    proxy.on('error', (e) => {
      // 响应头已发送时不能再 writeHead——直接断开，避免未捕获异常
      if (!res.headersSent) { res.writeHead(502); res.end('proxy error: ' + e.message) }
      else res.destroy()
    })
    req.pipe(proxy)
  })

  // WebSocket 升级隧道：DSH 的实时通道（events.mux / events.host）走 WebSocket
  // （审批/提问推送、会话实时事件）。认证 + Host/Origin 改写与普通转发一致，
  // 握手成功后双向裸流透传。
  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="DSH Remote"\r\n\r\n')
      socket.destroy()
      return
    }
    if (req.url.startsWith('/mobile')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    // 路径白名单：只放行 DSH 的事件通道（收窄转发面）
    if (!/^\/api\/events\.(mux|host)/.test(req.url)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const headers = {
      ...req.headers,
      host: `${upstream.host}:${upstream.port}`,
      ...(req.headers.origin ? { origin: `http://${upstream.host}:${upstream.port}` } : {}),
    }
    const tunnel = netConnect(upstream.port, upstream.host, () => {
      const headLines = [
        `${req.method} ${req.url} HTTP/1.1`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`),
        '',
        '',
      ].join('\r\n')
      tunnel.write(headLines)
      if (head && head.length) tunnel.write(head)
    })
    const teardown = () => { socket.destroy(); tunnel.destroy() }
    tunnel.on('error', teardown)
    socket.on('error', teardown)
    socket.on('close', teardown)
    tunnel.on('close', teardown)
    socket.pipe(tunnel)
    tunnel.pipe(socket)
  })

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') onError(`端口 ${port} 被占用——请修改 proxyPort 配置`)
    else onError('认证代理错误: ' + e.message)
  })
  server.listen(port, '0.0.0.0')
  return server
}
