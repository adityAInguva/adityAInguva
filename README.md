# Pocket LED — Draw Pad

A full-page browser drawing pad that streams strokes to an ESP32 LED matrix over WebSocket. No backend — the browser talks directly to your ESP32.

## Run locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

Build a static site (GitHub Pages friendly — relative asset paths):

```bash
npm run build
npm run preview   # optional local check of dist/
```

Deploy the `dist/` folder anywhere static hosting works.

## Using the pad

1. Set **Matrix** width × height to match your LED panel (e.g. `64 × 32`).
2. Set **ESP32 WebSocket** to your device (default placeholder: `ws://192.168.4.1/ws`).
3. Click **Connect**, then draw. Use pen color/size, background color, and **Clear** as needed.

Settings persist in `localStorage`.

> Note: Mixed-content rules block `ws://` from HTTPS pages. Serve the site over HTTP locally, or use `wss://` on the ESP32 if you host the pad on HTTPS (e.g. GitHub Pages).

## ESP32 wire format

All messages are **JSON text frames** over a single WebSocket. Coordinates are LED cells: `x` in `[0, width)`, `y` in `[0, height)`, origin top-left. Colors are packed RGB integers `0xRRGGBB` (e.g. `0x3DFFB5` = 4063157).

### `init` — matrix size (sent on connect and when size changes)

```json
{ "type": "init", "width": 64, "height": 32 }
```

### `draw` — batched pixel updates (throttled ~30 Hz, up to 64 pts/message)

```json
{
  "type": "draw",
  "pts": [
    { "x": 10, "y": 5, "color": 4063157 },
    { "x": 11, "y": 5, "color": 4063157 }
  ]
}
```

Identical consecutive paints to the same cell are deduped client-side. Fast strokes are line-filled (Bresenham) so Wi‑Fi batching does not skip cells.

### `clear` — wipe the matrix

```json
{ "type": "clear" }
```

Followed immediately by a `bg` message with the current background color.

### `bg` — background / fill color

```json
{ "type": "bg", "color": 463640 }
```

### Suggested ESP32 handling

1. Accept WebSocket clients on a path such as `/ws`.
2. On `init`, store width/height (ignore out-of-range points later).
3. On `draw`, set each `(x, y)` to `color`.
4. On `clear`, blank the framebuffer; on `bg`, fill with that color (and/or store as clear color).
5. Keep the parser tolerant of extra fields for future revisions.

Sketch (Arduino-style pseudocode):

```cpp
// After reading a text frame into `payload`:
// parse JSON "type"
// if "init"  -> width = ..., height = ...
// if "draw"  -> for each pts[i]: setPixel(pts[i].x, pts[i].y, pts[i].color)
// if "clear" -> clearFramebuffer()
// if "bg"    -> fillFramebuffer(color)
```
