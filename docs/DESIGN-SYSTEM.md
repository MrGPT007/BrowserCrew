# NeoBrutal Soft — Design Language

## Identity

NeoBrutal Soft is the SaaS/application flavor of the NeoBrutalism family.

It preserves the family traits—visible structure, direct contrast, tactile depth, obvious affordance, and physical micro-interaction—while reducing the visual aggression of classic Neo-Brutalism for long-session interfaces.

**Conceptual material:** coated plastic / soft-touch hardware.

The interface should feel calm, durable, touchable, and precise.

## Family law

**Compress, never float.**

Ordinary interactive surfaces must not rise toward the user on hover. Raised controls compress toward their shadow. Pressed controls seat into the surface.

Exceptions must communicate a different physical meaning, such as drag-and-drop where an object is actually being picked up.

## Visual grammar

### Structure

- Borders are visible and intentional.
- Default structural border: `2px`.
- Strong emphasis may use `3px`.
- Soft uses moderate rounding rather than sharp raw-brutalist corners.
- Shadows are shallow and hard, not blurry elevation shadows.
- Static information should not imitate interactive depth.

### Depth

Default Soft depth:

- Rest: `3px 3px`
- Hover: `1.5px 1.5px`
- Active: `0 0`
- Surface translation mirrors lost depth.

Depth is semantic, not decorative.

### Typography

Use a sturdy sans-serif system stack by default. Interfaces should prioritize readability and density over branding theatrics.

Headings are bold with tight leading and mild negative tracking. Body text remains comfortable for long sessions.

All primary size tokens are fluid using `clamp()`.

### Color

Soft uses warm neutral surfaces rather than pure white/gray application chrome.

The primary accent is a softened blue. Supporting accents use mint, lilac, peach, yellow, and red. Pastels are bounded by strong structural ink/borders so the result remains Neo-Brutalist rather than soft-minimalist.

Dark mode is a first-class theme, not an inversion filter.

## Interaction model

### Raised controls

Buttons, icon buttons, interactive cards, checkboxes, and switches may use tactile hard-shadow depth.

State sequence:

`rest -> hover/contact -> press -> release -> result`

### Recessed controls

Inputs, textareas, data wells, and inset information surfaces should feel seated into the interface. They do not need raised hard-shadow behavior.

Focus should increase contact/edge emphasis rather than lift the field.

### Static surfaces

Informational cards remain stable. Motion is an affordance signal and should not be wasted on decorative hover effects.

## Motion

Soft motion is restrained.

- Press acknowledgement is fast.
- Release is controlled with minimal overshoot.
- Routine success feedback is compact.
- Large bouncy springs are not a default Soft behavior.
- Reduced-motion preferences must preserve state clarity while removing non-essential travel.

## Component principles

1. Every interactive component must define pointer, keyboard, touch, disabled, and focus-visible behavior.
2. Touch interaction must not depend on hover.
3. Focus-visible must be visually explicit and must not be replaced by motion alone.
4. Component-local arbitrary timing/depth values should be avoided when semantic tokens exist.
5. An interactive card may compress; an informational card should not.
6. Tab selection should feel seated/locked rather than elevated.
7. Toggle motion and state color should complete together.
8. Loading feedback should be local when possible and preserve layout.
9. Destructive actions must be visually distinct and should never rely only on color.

## Fluid UI

Use `clamp()` for scalable typography, spacing, control heights, content widths, and major layout dimensions. Prefer container-friendly layouts and avoid breakpoint-only thinking when fluid sizing can solve the problem.

## Accessibility

Target WCAG 2.2 AA for production components.

- visible `:focus-visible`
- keyboard-operable controls
- comfortable touch targets
- semantic HTML before ARIA recreation
- no hover-only instructions
- `prefers-reduced-motion` support
- state communicated by more than color where practical

## What Soft is not

Soft is not generic shadcn styling, glassmorphism, neumorphism, Material Design, or classic hard Neo-Brutalism.

It should remain recognizable as Neo-Brutalism through structure and physical interaction even when its color and density are calm.
