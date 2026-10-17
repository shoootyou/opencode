/**
 * @spec-handoff
 * @interface resolveLegacyLoginDestination(url: string): "/"
 * @behavior
 *   - Maps the legacy /login SPA route to the v2 root connect flow.
 *   - Ignores every legacy redirect query value rather than navigating to it.
 * @edge-cases
 *   - Preserves same-origin safety by ignoring valid and malicious redirect values alike.
 *   - Malformed percent encoding and C0 control characters never change the destination.
 * @see ./routes.tsx
 */

import { describe, expect, test } from "bun:test"
import { resolveLegacyLoginDestination } from "./legacy-login"

describe("legacy login route", () => {
  test.each([
    ["/login"],
    ["/login?redirect=/x"],
    ["/login?redirect=//evil.example"],
    ["/login?redirect=/\\evil.example"],
    ["/login?redirect=https://evil.example"],
    ["/login?redirect=%2F%2Fevil.example"],
    ["/login?redirect=%E0%A4%A"],
    ["/login?redirect=%2F%09%2Fevil.example"],
  ])("routes %s to the v2 root connect flow and ignores redirect", (url) => {
    expect(resolveLegacyLoginDestination(url)).toBe("/")
  })
})
