import http from 'node:http'
import { loadConfig } from './config.mjs'
import { createLogger } from './logger.mjs'
import { UserAuth } from './auth.mjs'
import { BackendManager } from './backends.mjs'
import { createProxyHandler, createUpgradeHandler } from './proxy.mjs'
import { createAuthHandler } from './auth-server.mjs'
import { createPathPolicy } from './path-policy.mjs'

const logger = createLogger('dsh-multiuser')
const traceId = `startup-${Date.now()}`

try {
  const config = loadConfig()
  const auth = new UserAuth(config)
  const backends = new BackendManager(config, logger)
  const pathPolicy = createPathPolicy(config.pathPolicy)
  const authServer = http.createServer(createAuthHandler({ auth, logger }))
  const proxyServer = http.createServer(createProxyHandler({
    auth, backends, logger, pathPolicy, publicHost: config.publicHost,
  }))
  proxyServer.on('upgrade', createUpgradeHandler({
    auth, backends, logger, publicHost: config.publicHost,
  }))

  authServer.listen(config.authPort, '127.0.0.1', () => {
    logger.info('system_started', {
      traceId, component: 'auth_server', port: config.authPort,
      reason: 'listen_ready',
    })
  })
  proxyServer.listen(config.proxyPort, '127.0.0.1', () => {
    logger.info('system_started', {
      traceId, component: 'proxy_server', port: config.proxyPort,
      reason: 'listen_ready',
    })
  })

  const shutdown = signal => {
    logger.info('system_stopped', {
      traceId, signal, reason: 'signal_received',
    })
    authServer.close()
    proxyServer.close()
    setTimeout(() => process.exit(0), 250).unref()
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
} catch (error) {
  logger.error('error_occurred', {
    traceId, error_type: error?.name ?? 'Error',
    reason: 'startup_configuration_failed',
    error_message: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
}
