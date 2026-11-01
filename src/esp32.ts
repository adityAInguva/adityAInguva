import type { EspMessage, DrawPoint, Rgb } from './protocol'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export type Esp32ClientOptions = {
  url: string
  matrixWidth: number
  matrixHeight: number
  /** Flush interval for batched draw points (ms). */
  flushIntervalMs?: number
  /** Max points per draw message. */
  maxBatchSize?: number
  onState?: (state: ConnectionState, detail?: string) => void
}

/**
 * Batched WebSocket client for streaming LED pixels to an ESP32.
 * Queues draw points and flushes on a timer (and when the batch is full).
 */
export class Esp32Client {
  private ws: WebSocket | null = null
  private url: string
  private matrixWidth: number
  private matrixHeight: number
  private flushIntervalMs: number
  private maxBatchSize: number
  private onState?: (state: ConnectionState, detail?: string) => void

  private queue: DrawPoint[] = []
  private flushTimer: number | null = null
  private lastKey = new Map<string, number>() // dedupe identical consecutive cell paints
  private intentionalClose = false
  private everConnected = false
  private reconnectTimer: number | null = null
  private connectTimer: number | null = null

  constructor(opts: Esp32ClientOptions) {
    this.url = opts.url
    this.matrixWidth = opts.matrixWidth
    this.matrixHeight = opts.matrixHeight
    this.flushIntervalMs = opts.flushIntervalMs ?? 33
    this.maxBatchSize = opts.maxBatchSize ?? 64
    this.onState = opts.onState
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  configure(opts: Partial<Pick<Esp32ClientOptions, 'url' | 'matrixWidth' | 'matrixHeight'>>): void {
    if (opts.url !== undefined) this.url = opts.url
    if (opts.matrixWidth !== undefined) this.matrixWidth = opts.matrixWidth
    if (opts.matrixHeight !== undefined) this.matrixHeight = opts.matrixHeight
  }

  connect(): void {
    this.intentionalClose = false
    this.clearReconnect()
    this.clearConnectTimer()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }

    this.onState?.('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      this.onState?.('error', err instanceof Error ? err.message : 'Invalid WebSocket URL')
      return
    }
    this.ws = ws

    // Unreachable hosts can hang in CONNECTING; surface failure after a few seconds.
    this.connectTimer = window.setTimeout(() => {
      if (this.ws !== ws || ws.readyState === WebSocket.OPEN) return
      this.onState?.('error', 'Connect timeout')
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }, 5000)

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.clearConnectTimer()
      this.everConnected = true
      this.onState?.('connected')
      this.send({
        type: 'init',
        width: this.matrixWidth,
        height: this.matrixHeight,
      })
      this.startFlushLoop()
    })

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return
      this.clearConnectTimer()
      this.stopFlushLoop()
      this.ws = null
      if (this.intentionalClose) {
        this.onState?.('disconnected')
        return
      }
      // Only auto-retry after a prior successful session (Wi‑Fi blip), not on first fail.
      if (this.everConnected) {
        this.onState?.('disconnected', 'Reconnecting…')
        this.scheduleReconnect()
      } else {
        this.onState?.('error', 'Could not connect')
      }
    })

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return
      this.onState?.('error', 'WebSocket error — check URL / Wi‑Fi')
    })
  }

  disconnect(): void {
    this.intentionalClose = true
    this.everConnected = false
    this.clearReconnect()
    this.clearConnectTimer()
    this.stopFlushLoop()
    this.queue = []
    this.lastKey.clear()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.onState?.('disconnected')
  }

  /** Map a canvas-normalized cell into the queue (already in LED coords). */
  enqueuePoint(x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= this.matrixWidth || y >= this.matrixHeight) return
    const key = `${x},${y}`
    if (this.lastKey.get(key) === color) return
    this.lastKey.set(key, color)
    this.queue.push({ x, y, color })
    if (this.queue.length >= this.maxBatchSize) this.flush()
  }

  /** Stroke line between two LED cells (Bresenham) so fast swipes don't skip pixels. */
  enqueueLine(x0: number, y0: number, x1: number, y1: number, color: Rgb): void {
    let x = x0
    let y = y0
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy

    for (;;) {
      this.enqueuePoint(x, y, color)
      if (x === x1 && y === y1) break
      const e2 = 2 * err
      if (e2 > -dy) {
        err -= dy
        x += sx
      }
      if (e2 < dx) {
        err += dx
        y += sy
      }
    }
  }

  clear(bgColor: Rgb): void {
    this.queue = []
    this.lastKey.clear()
    this.send({ type: 'clear' })
    this.send({ type: 'bg', color: bgColor })
  }

  setBackground(color: Rgb): void {
    this.send({ type: 'bg', color })
  }

  /** Call after matrix size changes while connected. */
  sendInit(): void {
    this.lastKey.clear()
    this.send({
      type: 'init',
      width: this.matrixWidth,
      height: this.matrixHeight,
    })
  }

  flush(): void {
    if (!this.queue.length) return
    const pts = this.queue.splice(0, this.maxBatchSize)
    this.send({ type: 'draw', pts })
  }

  private send(msg: EspMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(msg))
    } catch {
      /* ignore send failures; close handler will reconnect */
    }
  }

  private startFlushLoop(): void {
    this.stopFlushLoop()
    this.flushTimer = window.setInterval(() => this.flush(), this.flushIntervalMs)
  }

  private stopFlushLoop(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect()
    this.reconnectTimer = window.setTimeout(() => {
      if (!this.intentionalClose) this.connect()
    }, 2000)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }
}
