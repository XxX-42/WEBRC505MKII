# UI Refactor: RC-202 Dense Layout (Final) 🎛️

## Overview
Refactored the `TrackUnit` component to a **Dense Hybrid Layout** inspired by the RC-202, featuring compact rectangular control buttons, a full-height fader, and a concentric lower halo deck with zero wasted space.

---

## ✅ **Layout Structure**

### 1. **Upper Deck (`.upper-deck`)**
A compact grid layout (`grid-template-columns: 48px 1fr`) designed to eliminate whitespace.

- **Left Controls (`.left-controls`):**
  - **Buttons:** `FX`, `TRACK`, `STOP`
  - **Shape:** **Rectangular** (`shape="rect"`) with rounded corners (4px).
  - **Alignment:** Vertically distributed to match fader height.
  - **Logic:**
    - `FX`: Toggles Filter Mode (Blue LED).
    - `TRACK`: Placeholder.
    - `STOP`: Stops the track.

- **Right Fader (`.right-fader`):**
  - **Fader:** `HardwareFader` (Full height, filling the deck).
  - **Function:** Controls Volume (default) or Filter (when FX is active).
  - **Visual:** Track centered, cap refined, matte finish.

### 2. **Lower Deck (`.lower-deck`)**
A concentric design merging visual feedback and primary control.

- **Container (`.halo-wrapper`):** Relative container (110x110px).
- **Layer 1 (Background):** `LoopHalo` (LED Ring, Circular).
  - *Change:* Removed central text (DUB/REC/PLAY) to avoid overlap.
- **Layer 2 (Foreground):** `REC/PLAY` Button (Circular, 64px).
  - *Alignment:* Absolute positioning with `translate(-50%, -50%)`.

---

## 🎨 **Visual Reference**

**RC-202 Dense Layout:**
```
[Label: TRACK 1]

┌── Upper Deck (Grid) ───┐
│ [FX] (Rect)  [Fader]   │
│ [TRACK] (Rect)  ║      │
│                 ║      │
│ [STOP] (Rect)   ▼      │
└────────────────────────┘

┌── Lower Deck ──────────┐
│      ╱─────╲           │
│     │ [REC] │ (Circle) │
│      ╲─────╱           │
└────────────────────────┘
```

---

## 🔧 **Technical Details**

### Global Design System (`src/style.css`)
- **Matte Finish:** Updated gradients for a more industrial look.
- **Sharper Corners:** `4px` border radius for buttons.
- **Tighter Spacing:** Reduced padding and gaps.

### Component Updates
- **`HardwareButton.vue`:** Added `shape="rect"` support with LED dots.
- **`HardwareFader.vue`:** Centered track and refined cap design.
- **`LoopHalo.vue`:** Removed central text for cleaner concentric look.

### Logic Binding
- **FX Button:** Bound to `toggleFilterMode`.
- **Fader:** Bound to `updateLevel` (handles both Volume and Filter).
- **State:** `isFilterActive` determines fader behavior and LED colors.

---

## ⚠️ **Current State**
- **Filter Control:** Fully implemented and bound to UI.
- **Layout:** Strictly follows RC-202 dense specification.
- **Aesthetics:** Industrial matte finish with precise alignment.

## 🚀 **Next Steps**
- Proceed to Phase 5 (Dedicated Knob) if planned.
