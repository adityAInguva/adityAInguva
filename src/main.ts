import './style.css'
import { DrawPad } from './drawPad'
import { Esp32Client, type ConnectionState } from './esp32'

const STORAGE_KEY = 'pocket-led-draw-pad'

type SavedSettings = {
  penColor: string
  bgColor: string
  penSize: number
  matrixW: number
  matrixH: number
  wsUrl: string
}

function loadSettings(): SavedSettings {
  const defaults: SavedSettings = {
    penColor: '#3dffb5',
    bgColor: '#071018',
    penSize: 8,
    matrixW: 64,
    matrixH: 32,
    wsUrl: 'ws://192.168.4.1/ws',
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    return defaults
  }
}

function saveSettings(s: SavedSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* ignore quota / private mode */
  }
}

const settings = loadSettings()

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark">
        <div class="brand-name">Pocket <span>LED</span></div>
      </div>
      <p class="brand-tag">Draw here · stream to your matrix</p>
    </div>
    <div class="status" id="conn-status" data-state="disconnected">
      <span class="status-dot" aria-hidden="true"></span>
      <span id="conn-label">Disconnected</span>
    </div>
  </header>

  <section class="stage" aria-label="Drawing pad">
    <canvas id="draw-canvas"></canvas>
    <canvas id="grid-overlay" aria-hidden="true"></canvas>

    <div class="toolbar" role="toolbar" aria-label="Draw controls">
      <div class="control">
        <label for="pen-color">Pen</label>
        <input id="pen-color" type="color" value="${settings.penColor}" />
      </div>

      <div class="control">
        <label for="pen-size">Size</label>
        <div class="control-row">
          <input id="pen-size" type="range" min="2" max="48" value="${settings.penSize}" />
          <span class="size-value" id="pen-size-label">${settings.penSize}</span>
        </div>
      </div>

      <div class="control">
        <label for="bg-color">Background</label>
        <input id="bg-color" type="color" value="${settings.bgColor}" />
      </div>

      <div class="control">
        <label for="matrix-w">Matrix</label>
        <div class="matrix-dims">
          <input id="matrix-w" type="number" min="1" max="256" value="${settings.matrixW}" title="Width" />
          <span>×</span>
          <input id="matrix-h" type="number" min="1" max="256" value="${settings.matrixH}" title="Height" />
        </div>
      </div>

      <div class="control">
        <label for="ws-url">ESP32 WebSocket</label>
        <input id="ws-url" type="text" value="${settings.wsUrl}" placeholder="ws://192.168.x.x/ws" spellcheck="false" />
      </div>

      <div class="actions">
        <button type="button" class="btn-ghost" id="btn-clear">Clear</button>
        <button type="button" class="btn-primary" id="btn-connect">Connect</button>
      </div>
    </div>
  </section>
`

const canvas = document.querySelector<HTMLCanvasElement>('#draw-canvas')!
const gridOverlay = document.querySelector<HTMLCanvasElement>('#grid-overlay')!
const penColor = document.querySelector<HTMLInputElement>('#pen-color')!
const penSize = document.querySelector<HTMLInputElement>('#pen-size')!
const penSizeLabel = document.querySelector<HTMLSpanElement>('#pen-size-label')!
const bgColor = document.querySelector<HTMLInputElement>('#bg-color')!
const matrixW = document.querySelector<HTMLInputElement>('#matrix-w')!
const matrixH = document.querySelector<HTMLInputElement>('#matrix-h')!
const wsUrl = document.querySelector<HTMLInputElement>('#ws-url')!
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!
const btnConnect = document.querySelector<HTMLButtonElement>('#btn-connect')!
const connStatus = document.querySelector<HTMLDivElement>('#conn-status')!
const connLabel = document.querySelector<HTMLSpanElement>('#conn-label')!

function persist(): void {
  saveSettings({
    penColor: penColor.value,
    bgColor: bgColor.value,
    penSize: Number(penSize.value),
    matrixW: Number(matrixW.value) || 64,
    matrixH: Number(matrixH.value) || 32,
    wsUrl: wsUrl.value.trim(),
  })
}

function readMatrix(): { width: number; height: number } {
  return {
    width: Math.max(1, Math.min(256, Number(matrixW.value) || 64)),
    height: Math.max(1, Math.min(256, Number(matrixH.value) || 32)),
  }
}

function setConnectionUi(state: ConnectionState, detail?: string): void {
  connStatus.dataset.state = state
  const labels: Record<ConnectionState, string> = {
    disconnected: 'Disconnected',
    connecting: 'Connecting…',
    connected: 'Connected',
    error: detail ? `Error · ${detail}` : 'Error',
  }
  connLabel.textContent = labels[state]
  const connected = state === 'connected'
  btnConnect.textContent = connected ? 'Disconnect' : 'Connect'
  btnConnect.dataset.connected = connected ? 'true' : 'false'
}

const esp = new Esp32Client({
  url: settings.wsUrl,
  matrixWidth: settings.matrixW,
  matrixHeight: settings.matrixH,
  onState: setConnectionUi,
})

const pad = new DrawPad({
  canvas,
  gridOverlay,
  getPenColor: () => penColor.value,
  getPenSize: () => Number(penSize.value),
  getBgColor: () => bgColor.value,
  getMatrix: readMatrix,
  esp,
})

penSize.addEventListener('input', () => {
  penSizeLabel.textContent = penSize.value
  persist()
})

penColor.addEventListener('input', persist)
wsUrl.addEventListener('change', persist)

bgColor.addEventListener('input', () => {
  pad.setBackgroundFromControl()
  persist()
})

function applyMatrix(): void {
  const { width, height } = readMatrix()
  matrixW.value = String(width)
  matrixH.value = String(height)
  esp.configure({ matrixWidth: width, matrixHeight: height })
  if (esp.connected) esp.sendInit()
  pad.redrawGrid()
  persist()
}

matrixW.addEventListener('change', applyMatrix)
matrixH.addEventListener('change', applyMatrix)

btnClear.addEventListener('click', () => pad.clear())

btnConnect.addEventListener('click', () => {
  if (esp.connected) {
    esp.disconnect()
    return
  }
  const url = wsUrl.value.trim() || 'ws://192.168.4.1/ws'
  wsUrl.value = url
  const { width, height } = readMatrix()
  esp.configure({ url, matrixWidth: width, matrixHeight: height })
  persist()
  esp.connect()
})

window.addEventListener('resize', () => pad.resize())

// First paint after layout settles.
requestAnimationFrame(() => pad.resize())
