/**
 * @spec-handoff
 * @interface showArchivedSessionsDialog(dialog: Pick<Dialog, "show">, server: string): void
 * @behavior
 *   - Uses the dialog API captured during owner setup, never calling useDialog from an action callback.
 *   - Opens the archived-session dialog for the captured server without a current Solid owner.
 * @see RFC 057 Addendum B.3 APP-02
 */
import { expect, test } from "bun:test"

type DialogSpy = { show: (content: never) => void }

test("opens through the setup-captured dialog API with no current owner", async () => {
  const { showArchivedSessionsDialog } = await import("./dialog-archived-sessions")
  const shown: object[] = []

  const dialogOpener: unknown = showArchivedSessionsDialog
  // SAFETY: This test invokes the setup-captured dialog adapter with only the public show callback and server inputs.
  const open = dialogOpener as (dialog: DialogSpy, server: string) => void

  expect(() => open({ show: (content) => shown.push(content) }, "server-a")).not.toThrow()
  expect(shown).toHaveLength(1)
})
