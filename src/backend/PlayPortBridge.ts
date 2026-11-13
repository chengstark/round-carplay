import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

export type PlayPortBridgeOptions = {
  upstreamUrl?: string
  allowSelfSignedCertificate: boolean
  allowOrigin(origin: string | undefined): boolean
}

/**
 * Same-origin WebSocket bridge between the Chromium kiosk and the PlayPort
 * companion service. PlayPort remains headless: the browser never loads its
 * HTML application, handles its certificate, or learns its access token.
 */
export class PlayPortBridge {
  private readonly server = new WebSocketServer({ noServer: true, perMessageDeflate: false })

  constructor(
    httpServer: HttpServer,
    private readonly options: PlayPortBridgeOptions
  ) {
    httpServer.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head))
    this.server.on('connection', (client) => this.connect(client))
  }

  get configured(): boolean {
    return Boolean(this.options.upstreamUrl)
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname !== '/playport') return

    if (!this.options.allowOrigin(request.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    this.server.handleUpgrade(request, socket, head, (client) => {
      this.server.emit('connection', client, request)
    })
  }

  private connect(client: WebSocket): void {
    const upstreamUrl = this.options.upstreamUrl
    if (!upstreamUrl) {
      client.send(JSON.stringify({
        type: 'bridge',
        sessionActive: false,
        message: 'PlayPort is not configured'
      }))
      client.close(1013, 'PlayPort is not configured')
      return
    }

    const upstream = new WebSocket(upstreamUrl, {
      perMessageDeflate: false,
      rejectUnauthorized: !this.options.allowSelfSignedCertificate
    })

    const closeBoth = (code = 1000, reason = 'bridge closed') => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason)
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(code, reason)
      }
    }

    upstream.on('open', () => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'bridge', sessionActive: true }))
      }
    })
    upstream.on('message', (data: RawData, isBinary: boolean) => {
      if (client.readyState !== WebSocket.OPEN) return
      client.send(data, { binary: isBinary })
    })
    upstream.on('close', (code, reason) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(webSocketCloseCode(code), reason.toString() || 'PlayPort disconnected')
      }
    })
    upstream.on('error', (error) => {
      console.warn('[PlayPortBridge] Upstream connection failed', error.message)
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'bridge',
          sessionActive: false,
          message: error.message
        }))
      }
      closeBoth(1011, 'PlayPort connection failed')
    })

    client.on('message', (data: RawData, isBinary: boolean) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
    })
    client.on('close', () => closeBoth())
    client.on('error', () => closeBoth(1011, 'browser connection failed'))
  }
}

function webSocketCloseCode(code: number): number {
  const protocolCode = code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)
  const applicationCode = code >= 3000 && code <= 4999
  return protocolCode || applicationCode ? code : 1012
}
