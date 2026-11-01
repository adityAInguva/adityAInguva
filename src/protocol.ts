/** Wire protocol for Pocket LED ↔ ESP32 (JSON over WebSocket). */

export type Rgb = number // 0xRRGGBB

export type InitMessage = {
  type: 'init'
  width: number
  height: number
}

export type DrawPoint = {
  x: number
  y: number
  color: Rgb
}

export type DrawMessage = {
  type: 'draw'
  pts: DrawPoint[]
}

export type ClearMessage = {
  type: 'clear'
}

export type BgMessage = {
  type: 'bg'
  color: Rgb
}

export type EspMessage = InitMessage | DrawMessage | ClearMessage | BgMessage

export function hexToRgb(hex: string): Rgb {
  const cleaned = hex.replace('#', '')
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned
  return parseInt(full, 16) >>> 0
}

export function rgbToHex(rgb: Rgb): string {
  return `#${(rgb >>> 0).toString(16).padStart(6, '0')}`
}
