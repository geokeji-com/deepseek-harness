import http from 'node:http'

const MAX_BODY = 4096

function clientIp(request) {
  const raw = request.headers['x-real-ip'] ?? request.socket.remoteAddress ?? 'unknown'
  return String(raw).split(',', 1)[0].trim().replace(/^::ffff:/u, '') || 'unknown'
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

function page(message = '', cookieHeader) {
  const notice = message === '' ? '' : `<p class="error">${escapeHtml(message)}</p>`
  const action = cookieHeader === undefined ? '/login' : '/login?logout=1'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness</title>
<style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101214;color:#f3f5f7}
main{width:min(92vw,380px);padding:30px;border:1px solid #2d3339;border-radius:8px;background:#171a1e}
h1{margin:0 0 8px;font-size:22px}p{margin:0 0 22px;color:#9da6af;line-height:1.5}
label{display:block;margin-bottom:8px;color:#c9d0d6;font-size:14px}
input,button{width:100%;height:44px;border-radius:6px;font:inherit}
input{border:1px solid #3b434b;background:#0f1113;color:#fff;padding:0 12px}
button{margin-top:14px;border:0;background:#356fe3;color:#fff;font-weight:650;cursor:pointer}
.error{color:#ff9b95}
</style></head><body><main><h1>DeepSeek Harness</h1>
<p>请输入访问密码。同一 IP 登录成功后，30 天内无需重复输入。</p>${notice}
<form method="post" action="${action}" autocomplete="current-password">
<label for="password">访问密码</label><input id="password" name="password" type="password" required autofocus>
<button type="submit">进入</button></form></main></body></html>`
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    request.on('data', chunk => {
      total += chunk.byteLength
      if (total > MAX_BODY) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

export function createAuthHandler({ auth, logger }) {
  return async function authHandler(request, response) {
    const traceId = `${Date.now()}-${process.pid}`
    const ip = clientIp(request)
    const url = new URL(request.url ?? '/', 'http://auth.invalid')

    if (request.method === 'GET' && url.pathname === '/healthz') {
      send(response, 200, 'ok\n')
      return
    }
    if (request.method === 'GET' && url.pathname === '/auth') {
      const userId = auth.verify(auth.parseCookie(request.headers.cookie), ip)
      logger.info(userId === undefined ? 'request_failed' : 'request_finished', {
        traceId, status_code: userId === undefined ? 401 : 204,
        user_id: userId ?? 'anonymous',
        reason: userId === undefined ? 'external_cookie_invalid' : 'external_cookie_valid',
      })
      response.writeHead(userId === undefined ? 401 : 204, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (request.method === 'GET' && url.pathname === '/login') {
      const current = auth.verify(auth.parseCookie(request.headers.cookie), ip)
      if (url.searchParams.get('logout') === '1') {
        response.writeHead(303, {
          location: '/login',
          'set-cookie': auth.clearCookieHeader(),
          'cache-control': 'no-store',
        })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(page('', current))
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/login') {
      send(response, 404, 'Not found.\n')
      return
    }

    const locked = auth.lockSeconds(ip)
    if (locked > 0) {
      logger.warn('request_failed', {
        traceId, status_code: 429, user_id: 'anonymous',
        client_ip: ip, retry_after_seconds: locked,
        reason: 'login_rate_limited',
      })
      response.writeHead(429, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page(`尝试次数过多，请在 ${String(locked)} 秒后重试。`))
      return
    }
    try {
      const password = new URLSearchParams(await readBody(request)).get('password') ?? ''
      const userId = auth.identify(password)
      if (userId === undefined) {
        auth.recordFailure(ip)
        logger.warn('request_failed', {
          traceId, status_code: 401, user_id: 'anonymous',
          client_ip: ip, reason: 'password_mismatch',
        })
        response.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        response.end(page('密码错误。'))
        return
      }
      auth.clearFailures(ip)
      logger.info('request_finished', {
        traceId, status_code: 303, user_id: userId, reason: 'password_match',
      })
      response.writeHead(303, {
        location: '/',
        'set-cookie': auth.cookieHeader(userId, ip),
        'cache-control': 'no-store',
      })
      response.end()
    } catch (error) {
      logger.error('request_failed', {
        traceId, status_code: 400, user_id: 'anonymous',
        error_type: error?.name ?? 'Error', reason: 'login_body_invalid',
      })
      send(response, 400, 'Bad request.\n')
    }
  }
}
