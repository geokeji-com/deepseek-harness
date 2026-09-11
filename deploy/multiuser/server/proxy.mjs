import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { REQUEST_PRINCIPAL_HEADER, stripInternalIdentityHeaders } from './principal.mjs'

function clientIp(request) {
  const raw = request.headers['x-real-ip'] ?? request.socket.remoteAddress ?? 'unknown'
  return String(raw).split(',', 1)[0].trim().replace(/^::ffff:/u, '') || 'unknown'
}

export function forwardedHeaders(request, cookie, publicHost, principal, upgrade = false) {
  const headers = { ...request.headers }
  delete headers.cookie
  delete headers.connection
  delete headers['proxy-connection']
  stripInternalIdentityHeaders(headers)
  headers.cookie = cookie
  headers.host = publicHost
  if (upgrade) {
    headers.connection = 'Upgrade'
  }
  headers['x-forwarded-proto'] = 'https'
  if (principal !== undefined) headers[REQUEST_PRINCIPAL_HEADER] = principal
  return headers
}

function copyResponseHeaders(headers) {
  const result = { ...headers }
  delete result['set-cookie']
  delete result.connection
  delete result['keep-alive']
  delete result['transfer-encoding']
  return result
}

function backendPort(state) {
  return state.port ?? state.user.port
}

function backendRequest(state, request, principal, body = true) {
  return new Promise((resolve, reject) => {
    const headers = forwardedHeaders(request, state.cookie, state.publicHost, principal)
    if (Buffer.isBuffer(body)) {
      headers['content-length'] = String(body.length)
      delete headers['transfer-encoding']
    }
    const upstream = http.request({
      host: '127.0.0.1',
      port: backendPort(state),
      method: request.method,
      path: request.url,
      headers,
    }, response => resolve({ upstream, response }))
    upstream.setTimeout(0)
    upstream.once('error', reject)
    if (Buffer.isBuffer(body)) {
      upstream.end(body)
    } else if (body && request.method !== 'GET' && request.method !== 'HEAD') {
      request.pipe(upstream)
    } else {
      upstream.end()
    }
  })
}

export function createProxyHandler({ auth, backends, logger, pathPolicy, principal, publicHost }) {
  return async function proxyHandler(request, response) {
    const traceId = randomUUID()
    const ip = clientIp(request)
    const cookie = auth.parseCookie(request.headers.cookie)
    const userId = auth.verify(cookie, ip)
    logger.info('request_received', {
      traceId, request_method: request.method, request_path: request.url,
      client_ip: ip, user_id: userId,
    })
    if (userId === undefined) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('authentication required\n')
      logger.warn('request_failed', {
        traceId, status_code: 401, user_id: 'anonymous',
        reason: 'external_cookie_invalid',
      })
      return
    }

    const started = Date.now()
    try {
      const inspected = pathPolicy === undefined
        ? { body: true }
        : await pathPolicy.inspectRequest(request, userId)
      if (inspected.response !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(inspected.response)
        logger.warn('request_failed', {
          traceId,
          request_method: request.method,
          request_path: request.url,
          status_code: 200,
          user_id: userId,
          reason: inspected.reason ?? 'path_policy_denied',
        })
        return
      }
      const state = await backends.ensure(userId, traceId)
      state.publicHost = publicHost
      const principalHeader = principal?.issue(userId, request.method ?? 'GET', request.url ?? '/')
      let result = await backendRequest(state, request, principalHeader, inspected.body)
      if (result.response.statusCode === 401
        && (request.method === 'GET' || request.method === 'HEAD')) {
        result.response.resume()
        await backends.refreshCookie(userId, traceId)
        result = await backendRequest(state, request, principalHeader, inspected.body)
      }
      const headers = copyResponseHeaders(result.response.headers)
      response.writeHead(result.response.statusCode ?? 502, headers)
      result.response.pipe(response)
      result.response.once('end', () => {
        backends.markUsed(userId)
        logger.info('request_finished', {
          traceId, status_code: result.response.statusCode, user_id: userId,
          latency_ms: Date.now() - started,
        })
      })
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('backend unavailable\n')
      } else {
        response.destroy()
      }
      logger.error('request_failed', {
        traceId, status_code: 502, user_id: userId,
        latency_ms: Date.now() - started,
        error_type: error?.name ?? 'Error',
        reason: 'backend_ensure_failed',
      })
    }
  }
}

export function createUpgradeHandler({ auth, backends, logger, principal, publicHost }) {
  return async function upgradeHandler(request, clientSocket, head) {
    const traceId = randomUUID()
    const ip = clientIp(request)
    const userId = auth.verify(auth.parseCookie(request.headers.cookie), ip)
    logger.info('request_received', {
      traceId, request_method: 'UPGRADE', request_path: request.url,
      client_ip: ip, user_id: userId ?? 'anonymous',
    })
    if (userId === undefined) {
      clientSocket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      clientSocket.destroy()
      return
    }
    try {
      const state = await backends.ensure(userId, traceId)
      state.publicHost = publicHost
      const principalHeader = principal?.issue(userId, request.method ?? 'GET', request.url ?? '/')
      const headers = forwardedHeaders(request, state.cookie, publicHost, principalHeader, true)
      const upstream = http.request({
        host: '127.0.0.1',
        port: backendPort(state),
        method: request.method,
        path: request.url,
        headers,
      })
      upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
        const lines = Object.entries(response.headers)
          .flatMap(([name, value]) => Array.isArray(value)
            ? value.map(item => `${name}: ${item}`)
            : [`${name}: ${value}`])
        clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
        if (head.byteLength > 0) upstreamSocket.write(head)
        if (upstreamHead.byteLength > 0) clientSocket.write(upstreamHead)
        upstreamSocket.pipe(clientSocket)
        clientSocket.pipe(upstreamSocket)
        const close = () => {
          upstreamSocket.destroy()
          clientSocket.destroy()
        }
        upstreamSocket.once('close', close)
        clientSocket.once('close', close)
        backends.markUsed(userId)
        logger.info('request_finished', {
          traceId, status_code: 101, user_id: userId, protocol: 'websocket',
        })
      })
      upstream.once('response', response => {
        clientSocket.write(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`,
        )
        response.resume()
        clientSocket.destroy()
        logger.warn('request_failed', {
          traceId, status_code: response.statusCode, user_id: userId,
          reason: 'websocket_upgrade_rejected',
        })
      })
      upstream.once('error', error => {
        clientSocket.destroy()
        logger.error('request_failed', {
          traceId, status_code: 502, user_id: userId,
          error_type: error?.name ?? 'Error', reason: 'websocket_proxy_failed',
        })
      })
      upstream.end()
    } catch (error) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      clientSocket.destroy()
      logger.error('request_failed', {
        traceId, status_code: 502, user_id: userId,
        error_type: error?.name ?? 'Error', reason: 'websocket_backend_unavailable',
      })
    }
  }
}
