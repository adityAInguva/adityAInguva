import { hexToRgb, type Rgb } from './protocol'
import type { Esp32Client } from './esp32'

export type DrawPadOptions = {
  canvas: HTMLCanvasElement
  gridOverlay: HTMLCanvasElement
  getPenColor: () => string
  getPenSize: () => number
  getBgColor: () => string
  getMatrix: () => { width: number; height: number }
  esp: Esp32Client
}

/**
 * Full-viewport drawing surface mapped onto an LED matrix grid.
 * Canvas strokes are painted smoothly; LED coords are quantized and streamed.
 */
export class DrawPad {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private grid: HTMLCanvasElement
  private gridCtx: CanvasRenderingContext2D
  private getPenColor: () => string
  private getPenSize: () => number
  private getBgColor: () => string
  private getMatrix: () => { width: number; height: number }
  private esp: Esp32Client

  private drawing = false
  private lastCanvas: { x: number; y: number } | null = null
  private lastLed: { x: number; y: number } | null = null
  private dpr = 1

  constructor(opts: DrawPadOptions) {
    this.canvas = opts.canvas
    const ctx = opts.canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx

    this.grid = opts.gridOverlay
    const gctx = opts.gridOverlay.getContext('2d')
    if (!gctx) throw new Error('2D canvas unavailable')
    this.gridCtx = gctx

    this.getPenColor = opts.getPenColor
    this.getPenSize = opts.getPenSize
    this.getBgColor = opts.getBgColor
    this.getMatrix = opts.getMatrix
    this.esp = opts.esp

    this.bindPointer()
    this.resize()
  }

  resize(): void {
    const parent = this.canvas.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.floor(rect.width))
    const h = Math.max(1, Math.floor(rect.height))

    for (const el of [this.canvas, this.grid]) {
      el.width = Math.floor(w * this.dpr)
      el.height = Math.floor(h * this.dpr)
      el.style.width = `${w}px`
      el.style.height = `${h}px`
    }

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.gridCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.fillBackground()
    this.drawGrid()
  }

  clear(): void {
    this.fillBackground()
    this.drawGrid()
    this.esp.clear(hexToRgb(this.getBgColor()))
  }

  setBackgroundFromControl(): void {
    this.fillBackground()
    this.drawGrid()
    this.esp.setBackground(hexToRgb(this.getBgColor()))
  }

  redrawGrid(): void {
    this.drawGrid()
  }

  private fillBackground(): void {
    const { width, height } = this.cssSize()
    this.ctx.fillStyle = this.getBgColor()
    this.ctx.fillRect(0, 0, width, height)
  }

  private cssSize(): { width: number; height: number } {
    return {
      width: this.canvas.width / this.dpr,
      height: this.canvas.height / this.dpr,
    }
  }

  private drawGrid(): void {
    const { width, height } = this.cssSize()
    const { width: mw, height: mh } = this.getMatrix()
    this.gridCtx.clearRect(0, 0, width, height)
    if (mw < 1 || mh < 1) return

    const cellW = width / mw
    const cellH = height / mh
    // Skip dense grids on small screens — keep atmosphere without noise.
    if (cellW < 4 || cellH < 4) return

    this.gridCtx.strokeStyle = 'rgba(61, 255, 181, 0.07)'
    this.gridCtx.lineWidth = 1
    this.gridCtx.beginPath()
    for (let x = 0; x <= mw; x++) {
      const px = Math.round(x * cellW) + 0.5
      this.gridCtx.moveTo(px, 0)
      this.gridCtx.lineTo(px, height)
    }
    for (let y = 0; y <= mh; y++) {
      const py = Math.round(y * cellH) + 0.5
      this.gridCtx.moveTo(0, py)
      this.gridCtx.lineTo(width, py)
    }
    this.gridCtx.stroke()
  }

  private bindPointer(): void {
    const start = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      this.canvas.setPointerCapture(e.pointerId)
      this.drawing = true
      const p = this.pointerPos(e)
      this.lastCanvas = p
      this.lastLed = this.toLed(p.x, p.y)
      this.paintStroke(p.x, p.y, p.x, p.y)
      e.preventDefault()
    }

    const move = (e: PointerEvent) => {
      if (!this.drawing || !this.lastCanvas) return
      const p = this.pointerPos(e)
      this.paintStroke(this.lastCanvas.x, this.lastCanvas.y, p.x, p.y)
      this.lastCanvas = p
      e.preventDefault()
    }

    const end = (e: PointerEvent) => {
      if (!this.drawing) return
      this.drawing = false
      this.lastCanvas = null
      this.lastLed = null
      this.esp.flush()
      try {
        this.canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }

    this.canvas.addEventListener('pointerdown', start)
    this.canvas.addEventListener('pointermove', move)
    this.canvas.addEventListener('pointerup', end)
    this.canvas.addEventListener('pointercancel', end)
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  private pointerPos(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
  }

  private toLed(cx: number, cy: number): { x: number; y: number } {
    const { width, height } = this.cssSize()
    const { width: mw, height: mh } = this.getMatrix()
    const x = Math.min(mw - 1, Math.max(0, Math.floor((cx / width) * mw)))
    const y = Math.min(mh - 1, Math.max(0, Math.floor((cy / height) * mh)))
    return { x, y }
  }

  private paintStroke(x0: number, y0: number, x1: number, y1: number): void {
    const color = this.getPenColor()
    const size = this.getPenSize()
    const rgb: Rgb = hexToRgb(color)

    this.ctx.strokeStyle = color
    this.ctx.fillStyle = color
    this.ctx.lineCap = 'round'
    this.ctx.lineJoin = 'round'
    this.ctx.lineWidth = size

    this.ctx.beginPath()
    this.ctx.moveTo(x0, y0)
    this.ctx.lineTo(x1, y1)
    this.ctx.stroke()

    // Also stamp endpoints so tiny taps register on the canvas.
    this.ctx.beginPath()
    this.ctx.arc(x1, y1, size / 2, 0, Math.PI * 2)
    this.ctx.fill()

    const led0 = this.lastLed ?? this.toLed(x0, y0)
    const led1 = this.toLed(x1, y1)
    const { width, height } = this.cssSize()
    const { width: mw, height: mh } = this.getMatrix()
    const cellDiag = Math.hypot(width / mw, height / mh)
    const brushCells = Math.max(1, Math.round(size / cellDiag))

    this.stampLedBrush(led0.x, led0.y, led1.x, led1.y, brushCells, rgb)
    this.lastLed = led1
  }

  private stampLedBrush(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    color: Rgb,
  ): void {
    // Walk the LED line and expand by brush radius in LED cells.
    let x = x0
    let y = y0
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    const r = Math.max(0, radius - 1)

    for (;;) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (ox * ox + oy * oy <= r * r + r) {
            this.esp.enqueuePoint(x + ox, y + oy, color)
          }
        }
      }
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
}
