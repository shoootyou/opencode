import { For, splitProps, type ComponentProps } from "solid-js"

const grid = 5
const dot = 2
const gap = 1
const origin = 1.5
const dots = Array.from({ length: grid * grid }, (_, index) => ({
  index,
  x: origin + (index % grid) * (dot + gap),
  y: origin + Math.floor(index / grid) * (dot + gap),
}))

export function SessionProgressIndicatorV2(props: ComponentProps<"svg"> & { color?: string }) {
  const [local, rest] = splitProps(props, ["class", "classList", "width", "height", "color", "style"])
  return (
    <svg
      {...rest}
      class={local.class}
      classList={local.classList}
      width={local.width ?? 16}
      height={local.height ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-component="session-progress-indicator-v2"
      aria-hidden={rest["aria-hidden"] ?? "true"}
      style={mergeColorIntoStyle(local.style, local.color)}
    >
      <For each={dots}>{(cell) => <rect data-dot={cell.index} x={cell.x} y={cell.y} width={dot} height={dot} />}</For>
    </svg>
  )
}

// Merges the `--session-progress-indicator-color` custom property into whatever `style` the
// caller already passed, instead of replacing it. `style` can be a `JSX.CSSProperties` object or
// a plain string (SolidJS's `ComponentProps<"svg">["style"]` type allows both).
function mergeColorIntoStyle(style: ComponentProps<"svg">["style"], color: string | undefined) {
  if (!color) return style
  if (typeof style === "string") return `${style};--session-progress-indicator-color:${color}`
  return { ...style, "--session-progress-indicator-color": color }
}
