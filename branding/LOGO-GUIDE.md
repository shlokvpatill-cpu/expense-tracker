# N.D. Patil Canteen logo: how to use it

**The idea:** a canteen bowl whose steam rises as three growing bars. It stands for food that adds up, a canteen that keeps good accounts.

## Files (in `final/`)
| Use | File |
|---|---|
| Main logo, any size from 48 px up | `logo-symbol.svg` (black) · `logo-symbol-mono-c2410c.svg` (orange) |
| On dark or orange backgrounds | `logo-symbol-white.svg` |
| Small sizes (under 48 px: icons, favicons, notifications) | `logo-symbol-small.svg`, which has thicker bars and wider gaps |
| App icon (white on an orange tile) | `logo-symbol-app-icon.svg` / `-512.png` |
| Profile picture / WhatsApp DP | `logo-symbol-square-512.png` or `icon-512.png` |
| Website icons | `favicon.ico`, `favicon.svg`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` and `head-snippet.html` |
| Windows app | `../../icon.ico` (built into the .exe) |

## Colour
| | HEX | RGB | Use |
|---|---|---|---|
| Canteen orange | `#C2410C` | 194 65 12 | Logo tile, buttons. White text on it passes the contrast check (5.2 : 1) |
| White | `#FFFFFF` | 255 255 255 | The mark on orange |
| Ink | `#1D2433` | 29 36 51 | The mark in one colour on light backgrounds |

## Rules
- **Clear space:** leave at least the width of one bar (about 1/9 of the logo's width) empty on every side.
- **Minimum size:** 16 px on screen (use the small version below 48 px) and 8 mm in print.
- **Backgrounds:** use orange or black on white or light backgrounds, and white on orange, dark or photo backgrounds.
- **Don't:** stretch it, rotate it, add shadows or gradients, change the number of bars, put orange on dark grey (too faint), or redraw the bars as a phone-signal icon.

## Where it's used in the app
- Android launcher icons, splash screen and reminder notification icon: redraw them with `npx electron scripts/make-icons.js` (the shape is set in that script).
- Desktop window, taskbar and .exe: `icon.ico`.
- Sidebar: inline in `index.html`.

## Notes
- Before using the logo on signs, packaging or anything public, get a trademark search done. This guide can't confirm the logo is free to register.
- There is no wordmark file yet. In the app the name is ordinary text next to the logo. For print signage, set the name in a bold sans-serif next to the logo and convert the text to outlines.
