import { createSignal, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { createComponent, Portal } from "solid-js/web"
import { Popover } from "@opencode-ai/ui/popover"
import { useServerSDK } from "@/context/server-sdk"
import { useTitlebarRightMount } from "./titlebar"
import {
  collapseView,
  createStore,
  dataRows,
  shouldRefetchSnapshot,
  snapshotReceivedAt,
  sortRows,
  toRows,
  writeEntry,
  type CollapseView,
  type Row,
} from "./plugin-status-indicator-logic"

// PURE presentational component — no context, no SDK, no store. Bun's own `.tsx` JSX transform
// (not babel-preset-solid) eagerly evaluates JSX props/children at the call site, which would
// silently freeze `open`/`children` at their first value under `bun test`. The Popover invocation
// and the glyph-vs-badge branch therefore go through `solid-js/web`'s `createComponent(...)`
// directly with getter-based prop objects, mirroring `PwaUpdatePrompt.tsx`'s established
// workaround, rather than raw JSX `<Popover>...</Popover>` syntax. Native DOM elements (span/div)
// below are plain JSX — each getter rebuilds them fresh on every reactive read, which is what a
// getter needs regardless of transform.
export function PluginStatusIndicatorView(props: { rows: Accessor<Row[]> }): JSX.Element {
  const [shown, setShown] = createSignal(false)
  // Sorted defensively here (not just by the SDK-wired caller) so the worst-severity badge and
  // row order stay correct regardless of the order the `rows` accessor supplies.
  const view = (): CollapseView => collapseView(sortRows(props.rows()))

  return createComponent<{ when: unknown; keyed?: false; fallback?: JSX.Element; children: JSX.Element }>(Show, {
    get when() {
      return view().kind !== "none"
    },
    get children(): JSX.Element {
      return createComponent(Popover, {
        get open() {
          return shown()
        },
        onOpenChange: setShown,
        get trigger() {
          return triggerContent(view())
        },
        get children() {
          const current = view()
          return popoverBody(current.kind === "none" ? [] : current.rows)
        },
      })
    },
  })
}

function triggerContent(view: CollapseView): JSX.Element {
  if (view.kind === "badge") {
    return (
      <span data-testid="plugin-status-indicator">
        <span data-testid="plugin-status-badge" data-severity={view.severity} data-count={String(view.count)} />
      </span>
    )
  }
  if (view.kind === "glyphs") {
    return (
      <span data-testid="plugin-status-indicator">
        {view.rows.map((row) => (
          <span
            data-testid="plugin-status-glyph"
            data-severity={row.severity}
            data-plugin-id={row.pluginID}
            data-event-name={row.eventName}
            data-directory={row.directory}
          />
        ))}
      </span>
    )
  }
  return null
}

// The final path segment after stripping a trailing separator (D22 row labelling). A directory
// with no separator at all (the literal "global") is its own basename verbatim. DATA, not copy —
// never translated, reformatted, or routed through the i18n layer.
function directoryBasename(directory: string): string {
  const trimmed = directory.replace(/[/\\]+$/, "")
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1)
}

// Rendered via ordinary JSX text interpolation (Solid's default `textContent`-writing behavior) —
// never `innerHTML`, never a template string parsed as markup, never an `<a href>` for any value
// (RFC 050 §2d rendering-safety acceptance criteria).
function popoverBody(rows: Row[]): JSX.Element {
  return (
    <div>
      {rows.map((row) => (
        <div
          data-testid="plugin-status-row"
          data-plugin-id={row.pluginID}
          data-event-name={row.eventName}
          data-directory={row.directory}
          title={row.directory}
        >
          <span data-testid="plugin-status-directory-label">{directoryBasename(row.directory)}</span>
          {dataRows(row.entry).map(([key, value]) => (
            <div data-testid="plugin-status-data-row" data-key={key}>
              {key}: {String(value)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// The real, SDK-wired component. Mounts once inside `Titlebar` (D8) so both layout shells carry
// it automatically. Owns the `Map`-based store, subscribes to every server event via
// `useServerSDK().event.listen(...)` (server-scoped — deliberately not the directory-scoped
// `useSDK()`, since `Titlebar` renders outside any `SDKProvider`: `ServerSDKProvider` wraps both
// shells at the router root, but `SDKProvider` is established only inside per-directory routes,
// e.g. `/:dir/session`, and would throw on `/` — see `DirectoryLayout`/`directory-layout.tsx`),
// filtering for `plugin.custom` (reading `.properties.pluginID` / `.event` / `.data`, never
// `.data.*`) and refetching `GET /plugin-ui/snapshot` on every `server.connected`.
export function PluginStatusIndicator(): JSX.Element {
  const serverSDK = useServerSDK()
  const mount = useTitlebarRightMount()
  const store = createStore()
  const [rows, setRows] = createSignal<Row[]>([])

  const refresh = () => setRows(sortRows(toRows(store, Date.now())))

  const refetchSnapshot = async () => {
    const result = await serverSDK()
      .client.pluginUi.snapshot({})
      .catch((error: unknown) => {
        console.error("Failed to refresh plugin UI snapshot", error)
        return undefined
      })
    const data = result?.data
    if (!data) return
    const now = Date.now()
    // D20/D21: a single response's `entries` may mix rows from multiple directories — each
    // entry's OWN `directory` field drives the write, never any ambient caller directory context.
    for (const entry of data.entries) {
      writeEntry(
        store,
        entry.directory,
        entry.pluginID,
        entry.event,
        entry.data,
        snapshotReceivedAt(now, data.serverTime, entry.publishedAt),
      )
    }
    refresh()
  }

  const stop = serverSDK().event.listen((payload) => {
    const event = payload.details
    if (event.type === "plugin.custom") {
      // D24: `payload.name` is the directory for a live event, taken verbatim (including the
      // literal string "global") — there is no client-side directory filter anywhere here.
      writeEntry(
        store,
        payload.name,
        event.properties.pluginID,
        event.properties.event,
        event.properties.data,
        Date.now(),
      )
      refresh()
      return
    }
    if (shouldRefetchSnapshot(event.type)) void refetchSnapshot()
  })
  onCleanup(stop)

  return (
    <Show when={mount()} keyed>
      {(target) => (
        <Portal mount={target}>
          <PluginStatusIndicatorView rows={rows} />
        </Portal>
      )}
    </Show>
  )
}
