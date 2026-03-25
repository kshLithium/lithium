import { describe, expect, it } from "vitest";
import {
  resolveAppEntryUrl,
  resolveBundledAssetPath,
  isSafeExternalUrl,
  isTrustedAppUrl,
  resolveRendererUrl
} from "./window-policy";

describe("window policy", () => {
  it("passes through the renderer development URL", () => {
    expect(resolveRendererUrl("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
  });

  it("limits external links to https and mailto", () => {
    expect(isSafeExternalUrl("https://example.com")).toBe(true);
    expect(isSafeExternalUrl("mailto:support@example.com")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });

  it("accepts only trusted renderer origins", () => {
    expect(isTrustedAppUrl("http://127.0.0.1:5173/", "http://127.0.0.1:5173")).toBe(true);
    expect(isTrustedAppUrl("http://127.0.0.1:4173/", "http://127.0.0.1:5173")).toBe(false);
    expect(isTrustedAppUrl("app://lithium/index.html")).toBe(true);
  });

  it("resolves the packaged renderer entry URL", () => {
    expect(resolveAppEntryUrl()).toBe("app://lithium/index.html");
  });

  it("locks packaged asset resolution to the trusted app origin", () => {
    expect(resolveBundledAssetPath("app://lithium/assets/index.js", "/tmp/dist")).toBe(
      "/tmp/dist/assets/index.js"
    );
    expect(() => resolveBundledAssetPath("https://lithium/index.html", "/tmp/dist")).toThrow(
      "Unexpected protocol"
    );
    expect(() => resolveBundledAssetPath("app://malicious/index.html", "/tmp/dist")).toThrow(
      "Unexpected host"
    );
  });
});
