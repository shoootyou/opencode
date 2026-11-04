/**
 * @spec-handoff
 * @interface ApiAuthView() in ./dialog.tsx (closure inside ProviderConnection)
 * @behavior
 *   - Shows an optional account-name TextInput (data-input="provider-account-name", autocomplete="off", spellcheck off) above the key field only when accounts().length > 0.
 *   - The key TextInput is type="password", autocomplete="new-password", spellcheck off, has no name attribute, no value= and no onInput; submit reads it from the input ref and clears it.
 *   - On submit, isDuplicateAccountName(name, accounts().map((a) => a.label)) runs before connectKey; a duplicate shows provider.connect.accountName.duplicate in formStore.error and does not call connectKey.
 *   - controller.auth.connectKey(key, label) runs inside try/catch; a failure shows only provider.connect.apiKey.failed.
 *   - The helper text provider.connect.apiKey.activeNote is shown with the name field.
 * @edge-cases
 *   - formatServerError and error.message never reach the key-submit UI: the gateway can echo a fragment of the pasted key.
 * @see ./account-label.ts
 * @see ./controller.ts
 * @testability ApiAuthView is a closure inside ProviderConnection, which needs the whole server, data and dialog provider graph, and the bun Solid shim evaluates JSX children eagerly and ignores classList. A DOM mount is not feasible, so these assertions read dialog.tsx as text, scoped to the ApiAuthView body and to each TextInput element. They are brittle by nature; the e2e scenario in e2e/regression/settings.spec.ts covers the rendered behavior.
 */
import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./dialog.tsx", import.meta.url)).text()

const START = "function ApiAuthView()"

const END = "function OAuthCodeView()"

const start = source.indexOf(START)

const end = source.indexOf(END)

const view = start >= 0 && end > start ? source.slice(start, end) : ""

// Each element runs from its opening tag to the first self-closing "/>"; none of these inputs has a nested "/>".

const inputs = view
  .split("<TextInput")
  .slice(1)
  .map((chunk) => chunk.slice(0, chunk.indexOf("/>")))

const keyInput = inputs.find((chunk) => chunk.includes('data-input="provider-api-key"')) ?? ""

const nameInput = inputs.find((chunk) => chunk.includes('data-input="provider-account-name"')) ?? ""

describe("ApiAuthView scope", () => {
  test("is found between its start and end markers", () => {
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(view).toContain("handleSubmit")
  })

  test("contains the key input element", () => {
    expect(keyInput).not.toBe("")
  })
})

describe("key input", () => {
  test("is masked", () => {
    expect(keyInput).toContain('type="password"')
  })

  test("asks the browser not to autofill or store it", () => {
    expect(keyInput).toContain('autocomplete="new-password"')
    expect(keyInput).toContain("spellcheck={false}")
  })

  test("has no guessable name attribute", () => {
    expect(keyInput).not.toMatch(/\sname=/)
    expect(view).not.toContain('"apiKey"')
  })

  test("is uncontrolled: no value mirror and no input handler", () => {
    expect(keyInput).not.toMatch(/\svalue=/)
    expect(keyInput).not.toContain("onInput")
    expect(view).not.toContain("formStore.value")
    expect(view).not.toMatch(/setFormStore\(\s*"value"/)
  })

  test("is read from the input ref on submit and cleared afterwards", () => {
    expect(keyInput).toContain("ref={apiKey}")
    expect(view).toMatch(/apiKey[!?]?\.value/)
    expect(view).toMatch(/apiKey[!?]?\.value\s*=\s*""/)
  })
})

describe("account name input", () => {
  test("exists with the agreed data attribute and browser hints", () => {
    expect(nameInput).toContain('data-input="provider-account-name"')
    expect(nameInput).toContain('autocomplete="off"')
    expect(nameInput).toContain("spellcheck={false}")
  })

  test("is plain text, not masked", () => {
    expect(nameInput).toContain("data-input=")
    expect(nameInput).not.toContain('type="password"')
  })

  test("is rendered only when the provider already has an account", () => {
    expect(view).toMatch(/accounts\(\)\.length\s*>\s*0/)
    expect(view.indexOf("accounts().length")).toBeLessThan(view.indexOf('data-input="provider-account-name"'))
  })

  test("comes above the key field", () => {
    expect(view.indexOf('data-input="provider-account-name"')).toBeLessThan(
      view.indexOf('data-input="provider-api-key"'),
    )
    expect(view.indexOf('data-input="provider-account-name"')).toBeGreaterThanOrEqual(0)
  })

  test("uses the agreed label, placeholder and helper strings", () => {
    expect(view).toContain("provider.connect.accountName.label")
    expect(view).toContain("provider.connect.accountName.placeholder")
    expect(view).toContain("provider.connect.apiKey.activeNote")
  })
})

describe("submit", () => {
  test("imports the label helpers", () => {
    expect(source).toMatch(/import\s*\{[^}]*isDuplicateAccountName[^}]*\}\s*from\s*"\.\/account-label"/)
  })

  test("checks duplicates against the labels of this provider's accounts, before connecting", () => {
    expect(view).toMatch(/accounts\(\)\.map\(\(?\w+\)? => \w+\.label\)/)
    expect(view.indexOf("isDuplicateAccountName(")).toBeGreaterThanOrEqual(0)
    expect(view.indexOf("isDuplicateAccountName(")).toBeLessThan(view.indexOf("controller.auth.connectKey("))
  })

  test("shows the duplicate-name error in the inline error slot", () => {
    expect(view).toMatch(/setFormStore\(\s*"error",\s*language\.t\("provider\.connect\.accountName\.duplicate"\)/)
  })

  test("returns before connecting when the name is a duplicate", () => {
    const check = view.indexOf("isDuplicateAccountName(")
    const message = view.indexOf('language.t("provider.connect.accountName.duplicate")', check)
    const exit = view.indexOf("return", message)
    const call = view.indexOf("controller.auth.connectKey(")

    expect(check).toBeGreaterThanOrEqual(0)
    expect(message).toBeGreaterThan(check)
    expect(exit).toBeGreaterThan(message)
    expect(exit).toBeLessThan(call)
    expect(view).toMatch(/if\s*\(\s*isDuplicateAccountName\(/)
  })

  test("passes the key and the name to the controller", () => {
    expect(view).toMatch(/controller\.auth\.connectKey\(\s*\w+,\s*\w+/)
  })
})

describe("failure path", () => {
  test("wraps connectKey in try/catch", () => {
    const attempt = view.indexOf("try {")
    const call = view.indexOf("controller.auth.connectKey(")
    const handler = view.indexOf("catch", call)

    expect(attempt).toBeGreaterThanOrEqual(0)
    expect(attempt).toBeLessThan(call)
    expect(call).toBeLessThan(handler)
  })

  test("shows only the generic failure message", () => {
    expect(view).toMatch(/setFormStore\(\s*"error",\s*language\.t\("provider\.connect\.apiKey\.failed"\)\s*\)/)
  })

  test("never formats or interpolates the server error", () => {
    // Positive witness: the handler exists and sets the generic message.
    expect(view).toContain("provider.connect.apiKey.failed")
    expect(view).not.toContain("formatServerError")
    expect(view).not.toMatch(/\.message\b/)
    // The shared Console flow legitimately uses the provider.connect.console.* keys.
    expect(view).not.toMatch(/(?<![\w.])console\./)
  })
})
