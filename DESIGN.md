# AetherMacro Design Guide (Surveyor, dark coral)

**Source of truth:** the shipped UI in `ui/` and this document. `aethermacro-design.html` is the original mockup for layout and behaviour; its colours, fonts and radii are superseded by sections 2 to 4 here. Functional scope comes from `PLAN.md`.

## 1. Direction

AetherMacro is a precision instrument that lives over a game. The visual language is a **surveyor's field kit**: near-black warm ink, ivory type, one coral-orange accent for action, and three survey colors that identify zone shapes. Registration crosshairs, step segments and thin rules are the structural vocabulary. The interface should feel calm, exact and a little tactile.

Do not drift toward a generic dark developer tool. No terracotta, no neon, no gradient washes, no glow, no card grids.

## 2. Tokens

Define these as CSS variables (or the platform's equivalent) and never hardcode hex values in components.

| Token | Value | Use |
| :--- | :--- | :--- |
| `--ink` | `#0f0f0e` | App background |
| `--slate` | `#171715` | Sidebar, panels, dialogs |
| `--deep` | `#201f1d` | Hover fills, inactive segments |
| `--raise` | `#2a2926` | Selected nav, selected segment, input rails |
| `--line` | `rgba(250,249,245,.10)` | Dividers |
| `--line2` | `rgba(250,249,245,.22)` | Control borders |
| `--bone` | `#f5f4ee` | Primary text |
| `--fog` | `#a8a69c` | Secondary text |
| `--dim` | `#6f6d66` | Tertiary text, disabled, trimmed data |
| `--brass` | `#d97757` | Accent (coral orange). Primary action, focus, active marker, advisories. The token keeps its old name. |
| `--rect` | `#7aa7f0` | Rectangle zones |
| `--circ` | `#5fb89a` | Circle zones, success, running beacon |
| `--poly` | `#b39ce8` | Polygon zones |
| `--mad` | `#e5484d` | Emergency, destructive only. Kept a true red so it never reads as the orange accent. |

Rules:
- The coral accent (`--brass`) is the only primary color. Text on it is `#1a0f0a`.
- Zone colors always mean the zone shape (thumbnail, node, pass-bar segment, canvas outline). Point steps use brass. Do not reuse zone colors for unrelated meaning.
- Madder is reserved for abort and delete. Advisories use brass, not madder.
- Contrast: body text must stay at least 4.5:1 on its surface. `--dim` is for non-essential text only.

## 3. Typography

| Role | Family | Settings |
| :--- | :--- | :--- |
| Display | **Source Serif 4** | Page titles weight 500, tracking `-0.02em`, size `clamp(32px, 4.2vw, 50px)`. Section titles 21px. Brand mark. |
| Interface | **Instrument Sans** | Body 14px, weight 400. Row titles 15px, weight 600. Buttons, labels, nav. |
| Data | **JetBrains Mono** | Only for numbers that change or must align: coordinates, hex, timings, counters, key caps. `font-variant-numeric: tabular-nums`. |

Rules:
- Sentence case everywhere. No all-caps labels, no tracked-out eyebrows above headings, no "WORD — fragment" labels, no middle-dot chains, no trailing arrows on buttons or links.
- Use real units in words where short (`850 ms`, `radius 28`, `Box 120×45`). Use `×` and typographic apostrophes.
- Headings are plain. Do not color or italicize one word in a heading.
- Line length stays under 65 characters for paragraphs.
- Do not use any other typefaces. Load fonts from the provided families with system fallbacks.

## 4. Shape, spacing, structure

- **Squared corners:** 2 to 3px for data marks (segments, key caps), 5 to 7px for controls (buttons, inputs, segmented controls, toasts), 8 to 12px for panels, dialogs and floating glass. No pill shapes. Circles are kept only for data markers: ledger nodes and the beacon.
- **Spacing:** 4px base. Page padding 34 by 44px. Related controls 8 to 12px apart, groups 18 to 26px apart.
- **Structure through rules, not boxes.** Lists are ledgers with hairline dividers. Summary facts are a single row separated by vertical rules. Use a bordered panel only when content is a self-contained tool (inspector, recorder, hotkey table).
- **Shadows:** none on panels. Floating glass (overlays, HUD, pill) uses one deep shadow `0 24px 60px -12px #000c`.
- **Glass** (`#0f1a1de0`, `blur(18px)`, `--line2` border) is only for layers that float above the game.
- **Layout:** fixed 216px sidebar with a sliding selection marker, content left-aligned, max width 1180px. Below 860px the sidebar becomes a top scroll bar and multi-column rows collapse.

## 5. Signature elements

Reuse these before inventing anything new.

1. **Pass bar.** One segment per step, width proportional to its time, colored by zone shape. It is the picture of a sequence. Use the same idea wherever progress through steps is shown (status pill uses equal segments).
2. **Ledger rail.** A vertical hairline with circular nodes in zone color. Selected or running nodes fill and scale to 1.2.
3. **Zone thumbnail.** A 58×34 mini drawing of the zone shape in its color, with 13% fill and a 1.5px stroke.
4. **Registration crosshair.** The brand mark and point-zone marker.
5. **Distribution preview.** Brass curve, 15% brass fill between clamp lines, dashed clamp markers. Any new numeric range should preview itself the same way.

## 6. Components

- **Primary button:** coral fill, dark text, 7px radius, weight 600, with its hotkey in a `kbd`. One primary per view area.
- **Secondary button:** transparent, `--line2` border, 7px radius. Hover fills `--deep`. Destructive variant uses `--mad` text and border.
- **Key cap (`kbd`):** mono 11px, 2px bottom border, `--slate` fill.
- **Segmented control:** `--ink` track, selected option `--raise` with a `--line2` ring.
- **Select, text input:** `--ink` fill, `--line2` border, 6px radius. Range inputs use brass accent.
- **Sidebar nav:** text only, sentence case. The selection marker is one element that slides between items with a brass left edge.
- **Dialog:** `--slate`, 12px radius. Emergency uses a `--mad` border with a soft 4px ring. Advisory uses brass. Structure: short title (states what happened), one calm sentence, a telemetry list, then actions with the primary on the right.
- **Macro ledger:** same hairline-ledger pattern as steps. Columns: name with a fog sub-line (target, step count, last run), mini pass bar (8px high, 2px radius segments in zone colors), total time in mono, actions. Open is a secondary button; Duplicate and Delete appear on hover or focus.
- **Inline title:** the page title is editable in place. Hover shows a hairline underline, focus shows the brass ring, Enter commits, an empty value reverts.
- **Sidebar macro button:** shows the open macro name and step count and opens the Library.
- **Toast:** ivory fill, ink text, 8px radius, centered at the bottom, 1.8s.
- **Tables:** hairline rows, no zebra, conflicts shown in brass text beside the row.
- **Empty states:** one sentence saying what goes here and a primary button to create it. No illustrations.

## 7. Motion

Motion answers an action or marks a single arrival. No decorative looping except the running beacon.

| Token | Value | Use |
| :--- | :--- | :--- |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | View transitions, fades, line draws |
| `--spring` | `cubic-bezier(.34,1.45,.5,1)` | Selection marker, button press release, toast, node scale, dialog nudge |

- View change: fade and rise 10px, 500ms, `--ease`.
- First load of the sequence: the rail draws down, rows slide in with 70ms stagger. This is the one orchestrated entrance. Do not add entrances elsewhere.
- Buttons: `scale(.96)` on press, spring back.
- Test hits: dots ping in with a random 0 to 0.9s delay over 1.2s.
- Running: active pass-bar segment fills left to right linearly over the step time.
- Respect `prefers-reduced-motion` by disabling all of the above.

## 8. Screen inventory

Each screen maps to a section of `PLAN.md`.

| Screen | Plan section | Notes |
| :--- | :--- | :--- |
| Library | 11 | Macro ledger: name and target, mini pass bar, total time, Open. Hover reveals Duplicate and Delete. Search and New macro at the top right. The open macro has a brass edge. |
| Sequence | 4.4, 7 | Title (click to rename), fact row, pass bar, ledger. Hover reveals Edit, Duplicate, Delete. The sidebar macro button opens the Library. |
| Capture overlay | 4.1, 5 | Frozen scene, dim and blur, draw on canvas, floating palette. |
| Heads-up display | 9 | Telemetry HUD top-left, status pill bottom-center. Both click-through. |
| Step inspector | 6 | Form on the left, live distribution on the right. |
| Recorder | 4.2 | Trace with kept and trimmed segments, trim and smooth sliders. |
| Safety | 8, 7 | Emergency dialog and robotic-pattern advisory with one-click fix. |
| Hotkeys | 10 | Press-to-rebind table, conflict flags, chime previews. |

## 9. Components not in the design

When a screen or component is needed that the HTML does not show (run log, dry-run overlay, validator list, settings, heatmap, version history, onboarding), build it from the existing pieces:

1. Start from a **ledger** or **fact row** before reaching for a panel or card.
2. Use only tokens in section 2. Pick the zone color only if the item is about a zone shape.
3. Use the two typefaces in the roles above. Mono only for changing numbers.
4. Compose from the components in section 6. If a new one is unavoidable, match its radius to the hierarchy in section 4 and write it into this file.
5. Express progress as segments, ranges as the distribution preview, status as the beacon, and warnings as the brass dialog pattern.
6. Overlays that sit above the game use glass. Everything in the main window uses flat `--slate` or `--ink`.
7. Write copy as a calm, specific sentence in sentence case that says what happened and what to do.
8. Add motion only if it answers a user action, using `--ease` or `--spring`.

## 10. Do not

- Use terracotta, orange-red, acid green, or any gradient as decoration.
- Add glow, drop shadows on in-window panels, or blur on non-floating UI.
- Make grids of identical rounded cards.
- Use all-caps labels, eyebrow text, middle-dot meta strings, or arrow suffixes.
- Add icons where text is clear. If an icon is needed, use a 1.6px stroke line icon in `currentColor`.
- Stack more than one primary button in a view area.
- Animate on scroll or add hover lift to every surface.

## 11. Quality floor

- Visible 2px brass focus ring on every interactive element.
- Full keyboard path for every flow, including rebinding and the capture overlay.
- Hit targets at least 32px.
- Layouts work from 360px to 1920px.
- Never rely on color alone: zone shape is also shown by thumbnail geometry and text.

## 12. Saving and multiple macros

- The app holds many macros. Never design a screen that assumes a single profile.
- Every change autosaves. There is no Save button for macros. Toasts say what happened in plain words ("Step 6 added to Smithing loop", "Macro deleted, Ctrl+Z to undo").
- Every destructive action is undoable with `Ctrl+Z` and says so in its toast. Do not use confirm dialogs for deletes.
- Always keep at least one macro. New macros start empty with an empty-state row on the Sequence screen.
- The open macro is always visible: sidebar button, page title, and brass edge in the Library.
