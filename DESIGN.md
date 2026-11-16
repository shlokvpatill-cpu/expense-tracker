---
version: 1
name: N.D. Patil Canteen – app design system
description: >
  A calm, warm accounts app for a busy canteen. Money is the content: big, tabular numbers
  on quiet white cards, one canteen-orange accent for actions, green/red only for profit/loss
  and money owed. Built for a shop counter: one-hand phone use, fast keyboard entry on the PC,
  readable at a glance in bright daylight. Follows the logo (branding/LOGO-GUIDE.md).

colors:            # light theme (dark theme values in styles.css :root[data-theme="dark"])
  accent: "#c2410c"          # canteen orange – primary buttons, active nav, logo tile, focus ring
  accent-hover: "#9a3412"
  accent-soft: "#fff1e8"     # selected / highlighted surfaces
  accent-line: "#fdba74"
  canvas: "#f4f5f7"          # page background
  panel: "#ffffff"           # cards, popups
  panel-2: "#fafbfc"         # table heads, totals, inset areas
  ink: "#1d2433"             # main text
  muted: "#6b7385"           # labels, hints (min 4.5:1 on panel)
  line: "#e2e5eb"            # borders, dividers
  good: "#15803d"            # profit, paid, settled
  good-soft: "#e8f6ed"
  bad: "#b91c1c"             # loss, pending dues, delete
  bad-soft: "#fdecec"
  warn: "#a16207"            # reminders, licences expiring
  warn-soft: "#fdf6e3"
  side: "#1f2937"            # sidebar
  chart-income: "#0f766e"    # cash / online / business series
  chart-cost: "#c2410c"      # expenses series

typography:        # system fonts only – the app works offline on PC and phone
  family: '"Segoe UI", system-ui, -apple-system, Roboto, sans-serif'
  numbers: tabular-nums on every amount, everywhere
  scale:
    hero-number: { size: 32px, weight: 700, use: "the one number that matters on a screen (net profit today)" }
    stat-number: { size: 20px, weight: 700, phone: 17px }
    page-title:  { size: 21px, weight: 700, phone: 18px }
    card-title:  { size: 15px, weight: 600 }
    body:        { size: 14px, weight: 400, phone-inputs: 15px }
    label:       { size: 12px, weight: 400, color: muted }
    small:       { size: 11px, use: "pills, keyboard hints" }

spacing:           # 4-px grid
  scale: [4, 8, 12, 16, 20, 24, 32]
  card-padding: 16px (phone 12px)
  gap-between-cards: 16px (phone 12px)
  page-padding: 20px 24px (phone 0 12px)

radius:
  input-button: 7px
  card-tile: 10px
  popup: 12px (phone bottom sheet 14px top corners)
  pill: 99px
  logo-tile: 22% of size

elevation:
  default: none – cards use a 1px line border, no shadows
  overlay: popups and toast only (0 6px 20px rgba(0,0,0,.25))
---

# How screens are built

## Principles
1. **The number first.** Each screen leads with the figure the owner came for (today's profit, money to collect, pending to a vendor). Labels are small and muted; amounts are large, bold and right-aligned in tables.
2. **One accent.** Orange means "do something" (primary button, active page, focus). Never use orange for data – profit is green, dues/loss are red, reminders are amber.
3. **Colour is never the only signal.** Loss amounts also carry a minus sign; pills carry words ("Paid", "Bill"); alerts carry an icon or bold lead word.
4. **Counter-speed entry.** Forms follow the existing typing flow: Enter moves to the next box, Ctrl+Enter saves, amounts select on focus. On the phone, primary actions sit at the bottom within thumb reach.
5. **Quiet surfaces.** White cards on a light grey canvas, 1px borders, no shadows, no gradients, no decorative icons.

## Components
| Component | Rules |
|---|---|
| **Primary button** | Orange fill, white text, 7px radius, padding 7×14 (phone 9×14). One per area. |
| **Ghost button** | Panel fill, ink text, input-line border. Secondary actions. |
| **Danger / ✕** | Red text, no fill; always has `aria-label`; delete always asks first. |
| **Stat tile** | Label (12px muted) above value (20px bold tabular). Optional sub-line (12px muted). `good`/`bad` colours the value only. Accent tile = soft orange fill for the day's headline figure. |
| **Hero figure** | Max one per screen: 32px bold, with a one-line breakdown under it. |
| **Card** | Panel, 1px line border, 10px radius, 16px padding, 15px semibold title with optional right-aligned tools. |
| **Table** | 12px muted headings on panel-2; amounts right-aligned tabular; clickable rows highlight warm on hover/focus; a bold total row at the bottom. Wraps in a horizontal scroller on phones. |
| **Pill** | 11px, fully rounded, soft background + strong text of the same colour family. |
| **Alert** | Soft background + matching border, bold lead, a link to fix it ("Enter now →"), dismiss ✕ for the day. |
| **Input** | 1px input-line border, 7px radius, orange focus outline; label above, linked with `for`. Amounts use `inputmode="decimal"`. |
| **Popup** | Centred card on PC (560 / 920 / 1240px); bottom sheet on phone with sticky Save/Cancel bar. |
| **Chart** | Inline SVG, no library. Income in teal, costs in orange, profit green above zero / red below. Tap shows the figure on phones. |
| **Logo** | White mark on orange tile in the sidebar; see branding/LOGO-GUIDE.md. |

## Layout
- PC: 210px dark sidebar + content (max natural width, grids collapse at 1100px).
- Phone (≤760px): sidebar becomes a slide-in menu, sticky top bar with title + tools, stats in 2 columns, popups as bottom sheets, respects safe areas.

## Accessibility (enforced by `npm test`)
- Every box has a label; every icon button has `aria-label`.
- Visible focus ring on everything clickable; clickable rows reachable with Tab and Enter.
- Toasts are announced (`role="status"`); popups are `role="dialog"` named by their title.
- Animations off under reduced motion; tap targets ≥36px on phones.

## Do / Don't
- **Do** reuse `stat()`, `table()`, `card`, `pill`, `notice()` helpers from app.js – don't hand-roll new versions.
- **Do** keep every new colour as a token in both light and dark themes.
- **Don't** add web fonts, icon fonts, shadows on cards, or a second accent colour.
- **Don't** put more than one hero figure on a screen.
