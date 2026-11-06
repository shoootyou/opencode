/**
 * @spec-handoff
 * @interface ApiAuthView() in ./dialog.tsx (closure inside ProviderConnection)
 * @behavior
 *   - Shows an optional account-name TextInput (data-input="provider-account-name", autocomplete="off", spellcheck off) above the key field only when accounts().length > 0.
 *   - The key TextInput is type="password", autocomplete="new-password", spellcheck off; its attributes are exactly the allowlist asserted below (no name, value, defaultValue or on* handler); submit reads it from the input ref and clears it after the duplicate check and before the request.
 *   - Both inputs carry data-1p-ignore, data-lpignore="true" and data-bwignore="true" so password managers do not offer to save "name + key" as a login.
 *   - On submit, isDuplicateAccountName(label, accounts().map((a) => a.label)) runs before connectKey; a duplicate sets formStore.nameError (never formStore.error) to provider.connect.accountName.duplicate, focuses the name input, keeps the key and does not call connectKey.
 *   - formStore.nameError is cleared at the start of each submit and when the name input changes; the name input has invalid={!!formStore.nameError} and aria-describedby="provider-account-name-error" while set, and <... id="provider-account-name-error" role="alert"> shows the message. The key input's invalid and aria-describedby depend only on formStore.error.
 *   - controller.auth.connectKey(key, label) runs inside try/catch; key comes from the key ref, label from the name ref; a failure shows only provider.connect.apiKey.failed through a bare catch with no bound error.
 *   - The helper text provider.connect.apiKey.activeNote is shown with the name field.
 * @edge-cases
 *   - formatServerError and error.message never reach the key-submit UI: the gateway can echo a fragment of the pasted key.
 * @see ./account-label.ts
 * @see ./controller.ts
 * @testability ApiAuthView is a closure inside ProviderConnection, which needs the whole server, data and dialog provider graph, and the bun Solid shim evaluates JSX children eagerly and ignores classList. A DOM mount is not feasible, so these assertions read dialog.tsx as text, scoped to the ApiAuthView body and to each TextInput element. The stale key alert next to the name error cannot be proven by a mount here, so the start-of-submit reset is pinned as text. They are brittle by nature; the e2e scenario in e2e/regression/settings.spec.ts covers the rendered behavior.
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

// Attribute names of one element chunk: string values and brace expressions are collapsed first, so spreads show up as "{}".
function attributeNames(chunk: string) {
  let flat = chunk.replace(/"[^"]*"/g, '""')

  for (let before = ""; before !== flat; ) {
    before = flat
    flat = flat.replace(/\{[^{}]*\}/g, "{}")
  }

  return flat
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.split("=")[0]!)
    .sort()
}

const ignoreHints = ["data-1p-ignore", 'data-lpignore="true"', 'data-bwignore="true"']

const duplicateMessage = 'language.t("provider.connect.accountName.duplicate")'

// The submit handler body: from its declaration to the component's JSX return.
const submitStart = view.indexOf("async function handleSubmit")

const submit = view.slice(submitStart, view.indexOf("\n    return (", submitStart))

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

  test("carries exactly the agreed attributes: no handler, value, defaultValue, name or spread", () => {
    // The three password-manager hints are pinned by their own test below, so this one holds on any dialog state.
    const hints = ["data-1p-ignore", "data-bwignore", "data-lpignore"]

    expect(attributeNames(keyInput).filter((name) => !hints.includes(name))).toEqual([
      "aria-describedby",
      "autocomplete",
      "class",
      "data-input",
      "invalid",
      "placeholder",
      "ref",
      "spellcheck",
      "type",
    ])
  })

  test("tells password managers not to offer saving it", () => {
    for (const hint of ignoreHints) expect(keyInput).toContain(hint)
  })

  test("marks itself invalid and described only by the key error, never the name error", () => {
    expect(keyInput).toMatch(/invalid=\{[^}]*formStore\.error\b[^}]*\}/)
    expect(keyInput).toMatch(/aria-describedby=\{[^}]*formStore\.error\b[^}]*errorID[^}]*\}/)
    expect(keyInput).not.toContain("nameError")
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

  test("tells password managers not to offer saving it", () => {
    for (const hint of ignoreHints) expect(nameInput).toContain(hint)
  })

  test("is invalid and described by its own error while the duplicate error is set", () => {
    expect(nameInput).toMatch(/invalid=\{!!formStore\.nameError\}/)
    expect(nameInput).toMatch(/aria-describedby=\{[^}]*formStore\.nameError\b[^}]*"provider-account-name-error"[^}]*\}/)
  })

  test("clears its error when the name changes", () => {
    expect(nameInput).toMatch(/\son(?:Input|Change)=\{/)
    // The reset lives outside handleSubmit (the handler), and the submit clears it too (asserted below).
    expect(view.replace(submit, "")).toMatch(/setFormStore\(\s*"nameError",\s*undefined\s*\)/)
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

  test("shows the duplicate-name error in the name field's own slot, not the key's", () => {
    expect(view).toMatch(/setFormStore\(\s*"nameError",\s*language\.t\("provider\.connect\.accountName\.duplicate"\)/)
    expect(view).not.toMatch(/setFormStore\(\s*"error",\s*language\.t\("provider\.connect\.accountName\.duplicate"\)/)
  })

  test("renders the name error as an alert element with the id the name input points to", () => {
    const at = view.indexOf('id="provider-account-name-error"')
    const tag = view.slice(view.lastIndexOf("<", at), view.indexOf(">", at))

    expect(at).toBeGreaterThanOrEqual(0)
    expect(tag).toContain('role="alert"')
    expect(view).toMatch(/<Show\s+when=\{formStore\.nameError\}>[^]*?id="provider-account-name-error"/)
  })

  test("clears both the key error and the name error at the start of each submit, before any validation", () => {
    // A duplicate returns before the later request-time reset, so a stale key alert would stay next to the name error.
    const trim = submit.indexOf("key.trim()")
    const duplicate = submit.indexOf("isDuplicateAccountName(")

    for (const slot of ["error", "nameError"]) {
      const clear = submit.search(new RegExp(`setFormStore\\(\\s*"${slot}",\\s*undefined\\s*\\)`))

      expect(clear).toBeGreaterThanOrEqual(0)
      expect(clear).toBeLessThan(trim)
      expect(clear).toBeLessThan(duplicate)
    }
  })

  test("uses the key local only to read it, check it and send it", () => {
    // Comments and string literals are dropped so only code mentioning the identifier counts.
    const code = submit.replace(/\/\/.*$/gm, "").replace(/"[^"\n]*"/g, '""')

    const uses = code
      .split("\n")
      .filter((line) => /\bkey\b/.test(line))
      .map((line) => line.trim())

    expect(uses).toEqual([
      'const key = apiKey?.value ?? ""',
      "if (!key.trim()) {",
      "await controller.auth.connectKey(key, label)",
    ])
  })

  test("clears the name error at the start of each submit, before any validation", () => {
    const clear = submit.search(/setFormStore\(\s*"nameError",\s*undefined\s*\)/)

    expect(submitStart).toBeGreaterThan(0)
    expect(clear).toBeGreaterThanOrEqual(0)
    expect(clear).toBeLessThan(submit.indexOf("key.trim()"))
    expect(clear).toBeLessThan(submit.indexOf("isDuplicateAccountName("))
  })

  test("clears the key after the duplicate check returns and before the request, never after it", () => {
    const check = submit.indexOf("isDuplicateAccountName(")
    const exit = submit.indexOf("return", check)
    const clear = submit.search(/apiKey[!?]?\.value\s*=\s*""/)
    const call = submit.indexOf("controller.auth.connectKey(")

    expect(check).toBeGreaterThan(0)
    expect(exit).toBeGreaterThan(check)
    expect(clear).toBeGreaterThan(exit)
    expect(clear).toBeLessThan(call)
    expect(submit.match(/apiKey[!?]?\.value\s*=\s*""/g)).toHaveLength(1)
  })

  test("on a duplicate: sets the name error, then focuses the name input, then returns", () => {
    const check = submit.indexOf("isDuplicateAccountName(")
    const message = submit.indexOf(duplicateMessage, check)
    const focus = submit.search(/accountName[!?]?\.focus\(/)
    const exit = submit.indexOf("return", message)

    expect(message).toBeGreaterThan(check)
    expect(focus).toBeGreaterThan(message)
    expect(exit).toBeGreaterThan(focus)
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

  test("reads key and label from their own refs and forwards them in that order", () => {
    expect(view).toMatch(/const key = apiKey\?\.value \?\? ""/)
    expect(view).toMatch(/const label = accountName\?\.value \?\? ""/)
    expect(view.match(/connectKey\(/g)).toHaveLength(1)
    expect(view).toContain("await controller.auth.connectKey(key, label)")
    expect(keyInput).toContain("ref={apiKey}")
    expect(nameInput).toContain("ref={accountName}")
  })

  test("checks the typed label, not the key, for a duplicate", () => {
    expect(view).toMatch(/isDuplicateAccountName\(\s*label,/)
  })
})

describe("key retention", () => {
  test("the form store has no field that could mirror the key", () => {
    const declared = view.match(/createStore<\{([^}]*)\}>/)?.[1] ?? ""
    const names = [...declared.matchAll(/(\w+)\??\s*:/g)].map((match) => match[1]).sort()

    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => !["error", "nameError"].includes(name!))).toEqual([])
  })
})

describe("failure path", () => {
  test("catches without binding the error and only sets the generic message", () => {
    const handler = view.match(/\}\s*catch\b([^{]*)\{([^}]*)\}/)

    expect(view.match(/\bcatch\b/g)).toHaveLength(1)
    expect(handler?.[1]?.trim()).toBe("")
    expect(handler?.[2]?.replace(/\s+/g, " ").trim()).toBe(
      'if (alive) setFormStore("error", language.t("provider.connect.apiKey.failed"))',
    )
  })

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
