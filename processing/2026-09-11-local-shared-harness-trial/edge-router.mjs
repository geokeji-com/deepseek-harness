import http from 'node:http'
import net from 'node:net'

const edgeHost = process.env.EDGE_HOST ?? '127.0.0.1'
const edgePort = Number(process.env.EDGE_PORT ?? '3180')
const authPort = Number(process.env.AUTH_PORT ?? '3181')
const proxyPort = Number(process.env.MANAGER_PROXY_PORT ?? '3182')

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function targetPort(requestUrl) {
  const pathname = new URL(requestUrl ?? '/', 'http://localhost').pathname
  return pathname === '/login' || pathname === '/auth' || pathname === '/healthz'
    ? authPort
    : proxyPort
}

function hasLoginCookie(header) {
  return String(header ?? '')
    .split(';')
    .some(segment => segment.trim().startsWith('dsh-user='))
}

function forwardedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())),
  )
}

function sendGatewayError(response, status, message) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(`${message}\n`)
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (request.method === 'GET' && pathname === '/'
    && !hasLoginCookie(request.headers.cookie)) {
    response.writeHead(303, {
      location: '/login',
      'cache-control': 'no-store',
    })
    response.end()
    return
  }

  const port = targetPort(request.url)
  const upstream = http.request({
    host: '127.0.0.1',
    port,
    method: request.method,
    path: request.url,
    headers: forwardedHeaders(request.headers),
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode ?? 502, forwardedHeaders(upstreamResponse.headers))
    upstreamResponse.pipe(response)
  })

  upstream.setTimeout(0)
  upstream.once('error', error => {
    console.error(`edge request failed: ${error.message}`)
    sendGatewayError(response, 502, 'gateway unavailable')
  })
  request.once('aborted', () => upstream.destroy())
  request.pipe(upstream)
})

server.on('upgrade', (request, clientSocket, head) => {
  const port = targetPort(request.url)
  const upstream = net.connect(port, '127.0.0.1')
  let connected = false

  upstream.once('connect', () => {
    connected = true
    const version = request.httpVersion || '1.1'
    const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${version}`]
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index]
      const value = request.rawHeaders[index + 1]
      if (!HOP_BY_HOP.has(name.toLowerCase()) || name.toLowerCase() === 'upgrade') {
        lines.push(`${name}: ${value}`)
      }
    }
    lines.push('Connection: Upgrade')
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.byteLength > 0) upstream.write(head)
  })
  upstream.once('error', error => {
    console.error(`edge upgrade failed: ${error.message}`)
    if (!connected) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    }
    clientSocket.destroy()
  })
  upstream.once('close', () => clientSocket.destroy())
  clientSocket.once('close', () => upstream.destroy())
  upstream.pipe(clientSocket)
  clientSocket.pipe(upstream)
})

server.listen(edgePort, edgeHost, () => {
  console.log(`edge router listening on http://${edgeHost}:${String(edgePort)}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 250).unref()
  })
}
