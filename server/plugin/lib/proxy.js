// 认证代理（插件内嵌模块）：0.0.0.0:port → 127.0.0.1:upstreamPort
// 安全模型：密码校验通过才转发；转发时保留原始 Host 头
// （DSH 浏览器信任围栏的 Host/Origin 一致性检查依赖它——覆盖为 127.0.0.1
//  会导致 Origin(隧道域名) ≠ Host(127.0.0.1) → 全部 /api 403）
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { createGzip } from 'node:zlib'
import { readFileSync, existsSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, extname } from 'node:path'

/** 固定内部域名：DSH 端需配置 --trusted-host dsh.remote（见 README） */
export const TRUSTED_HOST = 'dsh.remote'

/** 移动 UI 静态目录（插件包内 lib/mobile） */
const MOBILE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'mobile')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function serveMobile(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let rel = url.pathname === '/mobile' ? 'index.html' : url.pathname.slice('/mobile/'.length)
  if (!rel || rel.endsWith('/')) rel += 'index.html'
  const file = join(MOBILE_DIR, rel)
  if (!file.startsWith(MOBILE_DIR) || !existsSync(file)) {
    res.writeHead(404); res.end('not found'); return
  }
  const body = readFileSync(file)
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(body)
}

export function createAuthProxy({ port, upstreamPort, user = 'dsh', password, onError = () => {} }) {
  const upstream = { host: '127.0.0.1', port: upstreamPort }

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
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="DSH Remote"' })
      res.end('401 Unauthorized')
      return
    }
    // 移动 UI：/mobile 路径直接 serve 静态文件（不走转发）
    if (req.url.startsWith('/mobile')) {
      serveMobile(req, res)
      return
    }
    // Host/Origin 统一改写为固定内部域名：
    // 隧道域名每次重启会变，而 DSH 的 --trusted-host 启动时固定。
    // 固定为 dsh.remote 后，DSH 端一次配置永不用改。
    // 安全：代理是唯一入口，密码即边界；fence 只校验 Host/Origin 一致性。
    const headers = {
      ...req.headers,
      host: TRUSTED_HOST,
      ...(req.headers.origin ? { origin: `https://${TRUSTED_HOST}` } : {}),
    }
    const proxy = httpRequest(
      { host: upstream.host, port: upstream.port, path: req.url, method: req.method, headers },
      (upRes) => {
        // 大 JSON/文本响应流式 gzip：手机端拉取大会话历史(可达数 GB)时传输量降为 5-10%
        const acceptGzip = /gzip/i.test(req.headers['accept-encoding'] ?? '')
        const ctype = String(upRes.headers['content-type'] ?? '')
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
    proxy.on('error', (e) => { res.writeHead(502); res.end('proxy error: ' + e.message) })
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
    const headers = {
      ...req.headers,
      host: TRUSTED_HOST,
      ...(req.headers.origin ? { origin: `https://${TRUSTED_HOST}` } : {}),
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
