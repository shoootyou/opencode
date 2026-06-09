/**
 * @spec-handoff
 * @interface ProxyUtil.headers(input: Request | HeadersInit | Record<string, string>, extra?: HeadersInit): Headers
 * @behavior
 *   - Strips the "authorization" header from the output (RFC 017 A5/D4): client
 *     Basic credentials must never be forwarded to the UI upstream
 *     (app.opencode.ai) or to a different opencode instance via the API/WS proxy.
 *   - Retains non-hop, non-sensitive headers (e.g. "x-foo", "content-type").
 *   - "authorization" is added to the existing hop-by-hop strip set, alongside
 *     "proxy-authorization" which is already stripped.
 *   - `extra` is applied AFTER sanitize, so an explicit `authorization` passed via
 *     `extra` is preserved (documents the escape hatch + confirms sanitize order).
 * @edge-cases
 *   - Mixed-case header keys ("Authorization") are normalized by Headers and
 *     still stripped.
 *   - Request input form ({ headers }) strips authorization identically to the
 *     plain-object form.
 * @see ../../src/server/proxy-util.ts (hop set)
 */

import { describe, expect, test } from "bun:test"
import { ProxyUtil } from "../../src/server/proxy-util"

describe("ProxyUtil", () => {
  describe("websocketTargetURL", () => {
    test("converts http to ws", () => {
      expect(ProxyUtil.websocketTargetURL("http://example.com/path")).toBe("ws://example.com/path")
    })

    test("converts https to wss", () => {
      expect(ProxyUtil.websocketTargetURL("https://example.com/path")).toBe("wss://example.com/path")
    })

    test("preserves query params", () => {
      expect(ProxyUtil.websocketTargetURL("http://example.com/path?foo=bar")).toBe("ws://example.com/path?foo=bar")
    })

    test("accepts URL objects", () => {
      expect(ProxyUtil.websocketTargetURL(new URL("http://localhost:3000/ws"))).toBe("ws://localhost:3000/ws")
    })
  })

  describe("websocketProtocols", () => {
    test("returns empty array when no header", () => {
      const req = new Request("http://localhost")
      expect(ProxyUtil.websocketProtocols(req)).toEqual([])
    })

    test("parses single protocol", () => {
      const req = new Request("http://localhost", {
        headers: { "sec-websocket-protocol": "graphql-ws" },
      })
      expect(ProxyUtil.websocketProtocols(req)).toEqual(["graphql-ws"])
    })

    test("parses multiple protocols", () => {
      const req = new Request("http://localhost", {
        headers: { "sec-websocket-protocol": "graphql-ws, graphql-transport-ws" },
      })
      expect(ProxyUtil.websocketProtocols(req)).toEqual(["graphql-ws", "graphql-transport-ws"])
    })

    test("trims whitespace and filters empty", () => {
      const req = new Request("http://localhost", {
        headers: { "sec-websocket-protocol": " proto1 , , proto2 " },
      })
      expect(ProxyUtil.websocketProtocols(req)).toEqual(["proto1", "proto2"])
    })
  })

  describe("headers", () => {
    test("strips hop-by-hop headers", () => {
      const req = new Request("http://localhost", {
        headers: {
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          "content-type": "application/json",
        },
      })
      const result = ProxyUtil.headers(req)
      expect(result.get("connection")).toBeNull()
      expect(result.get("keep-alive")).toBeNull()
      expect(result.get("transfer-encoding")).toBeNull()
      expect(result.get("content-type")).toBe("application/json")
    })

    test("strips opencode-specific headers", () => {
      const req = new Request("http://localhost", {
        headers: {
          "x-opencode-directory": "/home/user/project",
          "x-opencode-workspace": "ws_123",
          "accept-encoding": "gzip",
          "x-custom": "keep",
        },
      })
      const result = ProxyUtil.headers(req)
      expect(result.get("x-opencode-directory")).toBeNull()
      expect(result.get("x-opencode-workspace")).toBeNull()
      expect(result.get("accept-encoding")).toBeNull()
      expect(result.get("x-custom")).toBe("keep")
    })

    test("merges extra headers", () => {
      const req = new Request("http://localhost", {
        headers: { "content-type": "application/json" },
      })
      const result = ProxyUtil.headers(req, { "x-auth": "token", "content-type": "text/plain" })
      expect(result.get("x-auth")).toBe("token")
      expect(result.get("content-type")).toBe("text/plain")
    })

    test("returns original headers when no extra", () => {
      const req = new Request("http://localhost", {
        headers: { "content-type": "application/json", "x-foo": "bar" },
      })
      const result = ProxyUtil.headers(req)
      expect(result.get("content-type")).toBe("application/json")
      expect(result.get("x-foo")).toBe("bar")
    })

    test("accepts plain object (HeadersInit) as input", () => {
      const result = ProxyUtil.headers(
        { "content-type": "application/json", connection: "keep-alive", "x-custom": "val" },
        { "x-extra": "added" },
      )
      expect(result.get("connection")).toBeNull()
      expect(result.get("content-type")).toBe("application/json")
      expect(result.get("x-custom")).toBe("val")
      expect(result.get("x-extra")).toBe("added")
    })

    // RFC 017 A5/D4 — never forward client Basic credentials to the UI upstream
    // (app.opencode.ai) or to a different opencode instance via the API/WS proxy.
    test("strips the authorization header (plain object input)", () => {
      const result = ProxyUtil.headers({
        authorization: "Basic abc",
        "x-foo": "bar",
      })
      expect(result.get("authorization")).toBeNull()
      expect(result.get("x-foo")).toBe("bar")
    })

    test("strips the authorization header (Request input)", () => {
      const req = new Request("http://localhost", {
        headers: { authorization: "Basic abc", "x-foo": "bar" },
      })
      const result = ProxyUtil.headers(req)
      expect(result.get("authorization")).toBeNull()
      expect(result.get("x-foo")).toBe("bar")
    })

    test("strips authorization regardless of header-key casing", () => {
      const result = ProxyUtil.headers({ Authorization: "Basic abc", "x-foo": "bar" })
      expect(result.get("authorization")).toBeNull()
      expect(result.get("x-foo")).toBe("bar")
    })

    test("preserves an explicit authorization passed via extra (sanitize runs before extra)", () => {
      const result = ProxyUtil.headers({ authorization: "Basic client" }, { authorization: "Basic explicit" })
      // The client credential is stripped by sanitize, then `extra` re-sets an
      // explicit value — the documented escape hatch for a trusted upstream.
      expect(result.get("authorization")).toBe("Basic explicit")
    })
  })

  // The RFC 017 server-middleware-reduction behaviors (uiRoute public, /doc
  // protected, typed-API bare 401 with no www-authenticate, no 302 redirect) are
  // now exercised as real integration tests against the Effect HTTP server
  // harness — see test/server/httpapi-ui.test.ts ("HttpApi UI fallback" and
  // "HttpApi /doc protection") and test/server/httpapi-authorization.test.ts.
  // They were promoted out of the test.todo stubs that previously lived here.
})
