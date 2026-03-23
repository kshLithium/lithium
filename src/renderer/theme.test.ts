import { describe, expect, it } from "vitest";
import {
  applyDocumentTheme,
  bootstrapDocumentTheme,
  getSystemPrefersDark,
  resolveThemeState
} from "./theme";

describe("renderer theme", () => {
  it("resolves system preference using the platform color scheme", () => {
    expect(resolveThemeState("system", true)).toEqual({
      themePreference: "system",
      resolvedTheme: "dark",
      systemTheme: "dark"
    });
    expect(resolveThemeState("system", false)).toEqual({
      themePreference: "system",
      resolvedTheme: "light",
      systemTheme: "light"
    });
  });

  it("detects prefers-color-scheme from matchMedia", () => {
    expect(
      getSystemPrefersDark({
        matchMedia: () => ({ matches: true } as MediaQueryList)
      })
    ).toBe(true);
    expect(
      getSystemPrefersDark({
        matchMedia: () => ({ matches: false } as MediaQueryList)
      })
    ).toBe(false);
  });

  it("applies the resolved theme to the document dataset and color scheme", () => {
    const targetDocument = {
      documentElement: {
        dataset: {},
        style: {
          colorScheme: ""
        }
      }
    } as unknown as Document;

    applyDocumentTheme(
      {
        themePreference: "system",
        resolvedTheme: "dark",
        systemTheme: "dark"
      },
      targetDocument
    );

    expect(targetDocument.documentElement.dataset.theme).toBe("dark");
    expect(targetDocument.documentElement.dataset.themePreference).toBe("system");
    expect(targetDocument.documentElement.style.colorScheme).toBe("dark");
  });

  it("bootstraps the document theme from the initial state", () => {
    const targetDocument = {
      documentElement: {
        dataset: {},
        style: {
          colorScheme: ""
        }
      }
    } as unknown as Document;

    bootstrapDocumentTheme(
      {
        themePreference: "dark",
        resolvedTheme: "dark",
        systemTheme: "dark"
      },
      {
        matchMedia: () => ({ matches: false } as MediaQueryList)
      },
      targetDocument
    );

    expect(targetDocument.documentElement.dataset.theme).toBe("dark");
    expect(targetDocument.documentElement.dataset.themePreference).toBe("dark");
  });
});
