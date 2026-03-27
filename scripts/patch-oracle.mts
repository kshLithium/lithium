import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Replacement = {
  relativePath: string;
  search: string;
  replace: string;
  replaceAll?: boolean;
};

const EXPECTED_VERSION = "0.9.0";

const replacements: Replacement[] = [
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/chromeLifecycle.js",
    search: "const execFileAsync = promisify(execFile);",
    replace: `const execFileAsync = promisify(execFile);
function describeConnectError(error, host, port) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ECONNREFUSED|socket hang up|ECONNRESET|ERR_CONNECTION_REFUSED/i.test(message)) {
        return \`connect ECONNREFUSED \${host}:\${port}\`;
    }
    return message;
}
async function waitForDevToolsReady(host, port, logger, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    let attempt = 0;
    while (Date.now() < deadline) {
        try {
            await CDP.Version({ host, port });
            if (attempt > 0) {
                logger(\`DevTools became reachable after \${attempt + 1} attempts on \${host}:\${port}\`);
            }
            return;
        }
        catch (error) {
            lastError = describeConnectError(error, host, port);
            attempt += 1;
            await delay(Math.min(1000, 250 * attempt));
        }
    }
    throw new Error(lastError || \`connect ECONNREFUSED \${host}:\${port}\`);
}`
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/chromeLifecycle.js",
    search: "export async function connectToChrome(port, logger, host) {\n    const client = await CDP({ port, host });\n    logger('Connected to Chrome DevTools protocol');\n    return client;\n}",
    replace: `export async function connectToChrome(port, logger, host) {
    const effectiveHost = host ?? '127.0.0.1';
    await waitForDevToolsReady(effectiveHost, port, logger);
    const client = await CDP({ port, host: effectiveHost });
    logger('Connected to Chrome DevTools protocol');
    return client;
}`
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/chromeLifecycle.js",
    search: "export async function connectToRemoteChrome(host, port, logger, targetUrl) {\n    if (targetUrl) {",
    replace: `export async function connectToRemoteChrome(host, port, logger, targetUrl) {
    await waitForDevToolsReady(host, port, logger);
    if (targetUrl) {`
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/chromeLifecycle.js",
    search: "    const retries = Math.max(0, options?.retries ?? 0);\n    const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);\n    const fallbackLabel = fallbackToDefault ? 'falling back to default target.' : 'strict mode: not falling back.';\n    let attempt = 0;",
    replace: `    const retries = Math.max(0, options?.retries ?? 0);
    const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);
    const fallbackLabel = fallbackToDefault ? 'falling back to default target.' : 'strict mode: not falling back.';
    await waitForDevToolsReady(effectiveHost, port, logger);
    let attempt = 0;`
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/actions/navigation.js",
    search: "      ok: !loginSignals && (status === 0 || status === 200),",
    replace: "      ok: !onAuthPage && status === 200,"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/constants.js",
    search: "export const DEFAULT_MODEL_TARGET = 'GPT-5.4 Pro';",
    replace: "export const DEFAULT_MODEL_TARGET = 'Pro';"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/cli/browserConfig.js",
    search:
      "const BROWSER_MODEL_LABELS = [\n    // Most specific first (e.g., \"gpt-5.2-thinking\" before \"gpt-5.2\")\n    ['gpt-5.4-pro', 'GPT-5.4 Pro'],\n    ['gpt-5.2-thinking', 'GPT-5.2 Thinking'],\n    ['gpt-5.2-instant', 'GPT-5.2 Instant'],\n    ['gpt-5.2-pro', 'GPT-5.4 Pro'],\n    ['gpt-5.1-pro', 'GPT-5.4 Pro'],\n    ['gpt-5-pro', 'GPT-5.4 Pro'],\n    // Base models last (least specific)\n    ['gpt-5.4', 'Thinking 5.4'],\n    ['gpt-5.2', 'GPT-5.2'], // Selects \"Auto\" in ChatGPT UI\n    ['gpt-5.1', 'GPT-5.2'], // Legacy alias → Auto\n    ['gemini-3-pro', 'Gemini 3 Pro'],\n    ['gemini-3-pro-deep-think', 'gemini-3-deep-think'],\n];",
    replace:
      "const BROWSER_MODEL_LABELS = [\n    // Current ChatGPT web surfaces model families in the top picker.\n    // Detailed thinking effort is selected separately from the composer pill.\n    ['gpt-5.4-pro', 'Pro'],\n    ['gpt-5.2-thinking', 'Thinking'],\n    ['gpt-5.2-instant', 'Auto'],\n    ['gpt-5.2-pro', 'Pro'],\n    ['gpt-5.1-pro', 'Pro'],\n    ['gpt-5-pro', 'Pro'],\n    ['gpt-5.4', 'Thinking'],\n    ['gpt-5.2', 'Auto'],\n    ['gpt-5.1', 'Auto'],\n    ['gemini-3-pro', 'Gemini 3 Pro'],\n    ['gemini-3-pro-deep-think', 'gemini-3-deep-think'],\n];"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/actions/modelSelection.js",
    search:
      "            const available = (result.hint?.availableOptions ?? []).filter(Boolean);\n            const availableHint = available.length > 0 ? ` Available: ${available.join(', ')}.` : '';\n            const tempHint = isTemporary && /\\bpro\\b/i.test(desiredModel)\n                ? ' You are in Temporary Chat mode; Pro models are not available there. Remove \"temporary-chat=true\" from --chatgpt-url or use a non-Pro model (e.g. gpt-5.2).'\n                : '';\n            throw new Error(`Unable to find model option matching \"${desiredModel}\" in the model switcher.${availableHint}${tempHint}`);",
    replace:
      "            const available = (result.hint?.availableOptions ?? []).filter(Boolean);\n            const visibleMenus = (result.hint?.visibleMenus ?? []).filter(Boolean);\n            const buttonLabel = (result.hint?.buttonLabel ?? '').trim();\n            const selectorHint = result.hint?.selectorFound === false ? ' Model selector button was not found.' : '';\n            const buttonHint = buttonLabel ? ` Current button: ${buttonLabel}.` : '';\n            const menuHint = visibleMenus.length > 0 ? ` Visible menu text: ${visibleMenus.join(' | ')}.` : '';\n            const availableHint = available.length > 0 ? ` Visible options: ${available.join(', ')}.` : '';\n            const tempHint = isTemporary && /\\bpro\\b/i.test(desiredModel)\n                ? ' You are in Temporary Chat mode; Pro models are not available there. Remove \"temporary-chat=true\" from --chatgpt-url or use a non-Pro model (e.g. gpt-5.2).'\n                : '';\n            throw new Error(`Unable to find model option matching \"${desiredModel}\" in the model switcher.${selectorHint}${buttonHint}${menuHint}${availableHint}${tempHint}`);"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/actions/modelSelection.js",
    search:
      "      const collectAvailableOptions = () => {\n        const menuRoots = Array.from(document.querySelectorAll(${menuContainerLiteral}));\n        const nodes = menuRoots.length > 0\n          ? menuRoots.flatMap((root) => Array.from(root.querySelectorAll(${menuItemLiteral})))\n          : Array.from(document.querySelectorAll(${menuItemLiteral}));\n        const labels = nodes\n          .map((node) => (node?.textContent ?? '').trim())\n          .filter(Boolean)\n          .filter((label, index, arr) => arr.indexOf(label) === index);\n        return labels.slice(0, 12);\n      };\n      const ensureMenuOpen = () => {",
    replace:
      "      const isVisibleNode = (node) => {\n        if (!(node instanceof HTMLElement) || typeof node.getBoundingClientRect !== 'function') {\n          return false;\n        }\n        const rect = node.getBoundingClientRect();\n        return rect.width > 0 && rect.height > 0;\n      };\n      const collectVisibleMenuText = () => {\n        return Array.from(document.querySelectorAll(${menuContainerLiteral}))\n          .filter((node) => isVisibleNode(node))\n          .map((node) => (node?.textContent ?? '').trim())\n          .filter(Boolean)\n          .slice(0, 4);\n      };\n      const collectAvailableOptions = () => {\n        const menuRoots = Array.from(document.querySelectorAll(${menuContainerLiteral})).filter((node) => isVisibleNode(node));\n        if (menuRoots.length === 0) {\n          return [];\n        }\n        const labels = menuRoots\n          .flatMap((root) => Array.from(root.querySelectorAll(${menuItemLiteral})))\n          .filter((node) => isVisibleNode(node))\n          .map((node) => (node?.textContent ?? '').trim())\n          .filter(Boolean)\n          .filter((label, index, arr) => arr.indexOf(label) === index);\n        return labels.slice(0, 12);\n      };\n      const ensureMenuOpen = () => {"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/actions/modelSelection.js",
    search:
      "          resolve({\n            status: 'option-not-found',\n            hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },\n          });",
    replace:
      "          resolve({\n            status: 'option-not-found',\n            hint: {\n              temporaryChat: detectTemporaryChat(),\n              availableOptions: collectAvailableOptions(),\n              visibleMenus: collectVisibleMenuText(),\n              buttonLabel: getButtonLabel(),\n              selectorFound: Boolean(button),\n            },\n          });"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search: "      valid: !onAuthPage && !hasLoginCta && hasTextarea,",
    replace: "      valid: !onAuthPage && hasTextarea,"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search: "    const chrome = reusedChrome ??\n        (await launchChrome({\n            ...config,\n            remoteChrome: config.remoteChrome,\n        }, userDataDir, logger));",
    replace:
      "    const chrome = reusedChrome ??\n        (await launchChrome({\n            ...config,\n            remoteChrome: config.remoteChrome,\n        }, userDataDir, logger));\n    if (!config.headless && config.hideWindow) {\n        await hideChromeWindow(chrome, logger);\n    }"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/chromeLifecycle.js",
    search: "    const chromeFlags = buildChromeFlags(config.headless ?? false, debugBindAddress);",
    replace:
      "    const chromeFlags = buildChromeFlags(config.headless ?? false, debugBindAddress, config.hideWindow ?? false);"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/chromeLifecycle.js",
    search: "function buildChromeFlags(headless, debugBindAddress) {",
    replace: "function buildChromeFlags(headless, debugBindAddress, hideWindow = false) {"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/chromeLifecycle.js",
    search: "    if (debugBindAddress) {\n        flags.push(`--remote-debugging-address=${debugBindAddress}`);\n    }\n    if (headless) {",
    replace:
      "    if (debugBindAddress) {\n        flags.push(`--remote-debugging-address=${debugBindAddress}`);\n    }\n    if (!headless && hideWindow) {\n        flags.push('--window-position=-2400,0', '--disable-features=CalculateNativeWinOcclusion');\n    }\n    if (headless) {"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search: "    let stopThinkingMonitor = null;",
    replace: "    let stopThinkingMonitor = null;\n    let stopAssistantPreviewMonitor = null;",
    replaceAll: true
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search: "        stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);",
    replace:
      "        stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);\n        stopAssistantPreviewMonitor = startAssistantPreviewMonitor(Runtime, logger, promptText, baselineTurns ?? undefined);",
    replaceAll: true
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search: "        stopThinkingMonitor?.();",
    replace: "        stopAssistantPreviewMonitor?.();\n        stopThinkingMonitor?.();",
    replaceAll: true
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search: "async function readThinkingStatus(Runtime) {",
    replace: `function startAssistantPreviewMonitor(Runtime, logger, promptText, minTurnIndex) {
    let stopped = false;
    let pending = false;
    let lastPreview = null;
    const promptEchoMatcher = buildPromptEchoMatcher(promptText);
    const interval = setInterval(async () => {
        if (stopped || pending) {
            return;
        }
        pending = true;
        try {
            const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex ?? undefined).catch(() => null);
            const preview = summarizeAssistantPreview(snapshot?.text, promptEchoMatcher);
            if (preview && preview !== lastPreview) {
                lastPreview = preview;
                logger(\`[assistant-preview] \${preview}\`);
            }
        }
        catch {
            // ignore DOM polling errors
        }
        finally {
            pending = false;
        }
    }, 1500);
    interval.unref?.();
    return () => {
        if (stopped) {
            return;
        }
        stopped = true;
        clearInterval(interval);
    };
}
function stripPreviewMarkup(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        return '';
    }
    const decoded = raw
        .replace(/<br\\s*\\/?>/gi, '\\n')
        .replace(/<\\/(?:p|div|section|article|li|h[1-6])>/gi, '\\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
    const paragraphs = decoded
        .split(/\\n+/)
        .map((segment) => segment.replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
    const deduped = [];
    for (const paragraph of paragraphs) {
        if (!deduped.includes(paragraph)) {
            deduped.push(paragraph);
        }
    }
    return deduped.join('\\n\\n').trim();
}
function summarizeAssistantPreview(raw, promptEchoMatcher) {
    const cleaned = stripPreviewMarkup(raw);
    if (!cleaned || promptEchoMatcher?.isEcho(cleaned)) {
        return '';
    }
    const candidate = cleaned.trim();
    if (!candidate || /^answer:\\s*$/i.test(candidate)) {
        return '';
    }
    const previewSource = candidate
        .split(/\\n{2,}/)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join('\\n\\n') || candidate;
    return previewSource.length > 420 ? \`\${previewSource.slice(0, 419).trimEnd()}…\` : previewSource;
}
async function readThinkingStatus(Runtime) {`
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/actions/promptComposer.js",
    search: "    await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);\n    const encodedPrompt = JSON.stringify(prompt);",
    replace:
      "    await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);\n    const normalizePromptText = (value) => String(value ?? '').replace(/\\\\s+/g, ' ').trim();\n    const promptNormalized = normalizePromptText(prompt);\n    const promptProbe = promptNormalized.slice(0, Math.min(200, promptNormalized.length));\n    const encodedPrompt = JSON.stringify(prompt);"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/actions/promptComposer.js",
    search: "    if (!editorTextTrimmed && !fallbackValueTrimmed && !activeValueTrimmed) {\n        // Learned: occasionally Input.insertText doesn't land in the editor; force textContent/value + input events.\n        await runtime.evaluate({\n            expression: `(() => {\n        const fallback = document.querySelector(${fallbackSelectorLiteral});\n        if (fallback) {\n          fallback.value = ${encodedPrompt};\n          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));\n          fallback.dispatchEvent(new Event('change', { bubbles: true }));\n        }\n        const editor = document.querySelector(${primarySelectorLiteral});\n        if (editor) {\n          editor.textContent = ${encodedPrompt};\n          // Nudge ProseMirror to register the textContent write so its state/send-button updates\n          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));\n        }\n      })()`,\n        });\n    }",
    replace:
      "    const matchesPrompt = (candidate) => {\n        const normalizedCandidate = normalizePromptText(candidate);\n        if (!promptProbe || !normalizedCandidate) {\n            return false;\n        }\n        return normalizedCandidate.includes(promptProbe) || promptProbe.includes(normalizedCandidate);\n    };\n    let requiresForceInsert = !matchesPrompt(editorTextTrimmed) && !matchesPrompt(fallbackValueTrimmed) && !matchesPrompt(activeValueTrimmed);\n    if (requiresForceInsert) {\n        // Learned: occasionally Input.insertText doesn't land in the editor after attachments settle;\n        // force the prompt into the visible composer and verify again before sending.\n        await runtime.evaluate({\n            expression: `(() => {\n        const fallback = document.querySelector(${fallbackSelectorLiteral});\n        const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};\n        const readValue = (node) => {\n          if (!node) return '';\n          if (node instanceof HTMLTextAreaElement) return node.value ?? '';\n          return node.innerText ?? '';\n        };\n        const isVisible = (node) => {\n          if (!node || typeof node.getBoundingClientRect !== 'function') return false;\n          const rect = node.getBoundingClientRect();\n          return rect.width > 0 && rect.height > 0;\n        };\n        const candidates = inputSelectors\n          .map((selector) => document.querySelector(selector))\n          .filter((node) => Boolean(node));\n        const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;\n        if (fallback) {\n          fallback.value = ${encodedPrompt};\n          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));\n          fallback.dispatchEvent(new Event('change', { bubbles: true }));\n        }\n        const editor = document.querySelector(${primarySelectorLiteral});\n        if (editor) {\n          editor.textContent = ${encodedPrompt};\n          // Nudge ProseMirror to register the textContent write so its state/send-button updates\n          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));\n        }\n        if (active) {\n          if (active instanceof HTMLTextAreaElement) {\n            active.value = ${encodedPrompt};\n            active.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));\n            active.dispatchEvent(new Event('change', { bubbles: true }));\n          } else {\n            active.textContent = ${encodedPrompt};\n            active.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));\n          }\n        }\n      })()`,\n        });\n        await delay(150);\n    }"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/actions/promptComposer.js",
    search: "    const observedEditor = postVerification.result?.value?.editorText ?? '';\n    const observedFallback = postVerification.result?.value?.fallbackValue ?? '';\n    const observedActive = postVerification.result?.value?.activeValue ?? '';\n    const observedLength = Math.max(observedEditor.length, observedFallback.length, observedActive.length);\n    if (promptLength >= 50_000 && observedLength > 0 && observedLength < promptLength - 2_000) {",
    replace:
      "    const observedEditor = postVerification.result?.value?.editorText ?? '';\n    const observedFallback = postVerification.result?.value?.fallbackValue ?? '';\n    const observedActive = postVerification.result?.value?.activeValue ?? '';\n    const observedLength = Math.max(observedEditor.length, observedFallback.length, observedActive.length);\n    const promptPresentAfterForceInsert = matchesPrompt(observedEditor) || matchesPrompt(observedFallback) || matchesPrompt(observedActive);\n    if (!promptPresentAfterForceInsert) {\n        await logDomFailure(runtime, logger, 'prompt-not-in-composer');\n        throw new BrowserAutomationError('Prompt text did not land in the composer before send.', {\n            stage: 'submit-prompt',\n            code: 'prompt-not-in-composer',\n            promptLength,\n            observedLength,\n            observedPreview: [observedEditor, observedFallback, observedActive]\n                .map((value) => String(value ?? '').trim())\n                .filter((value) => value.length > 0)\n                .slice(0, 3),\n        });\n    }\n    if (promptLength >= 50_000 && observedLength > 0 && observedLength < promptLength - 2_000) {"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/actions/assistantResponse.js",
    search: "            const completionStableTarget = shortAnswer ? 12 : mediumAnswer ? 8 : longAnswer ? 6 : 8;\n            const requiredStableCycles = shortAnswer ? 12 : mediumAnswer ? 8 : longAnswer ? 8 : 10;\n            const stableMs = Date.now() - lastChangeAt;\n            const minStableMs = shortAnswer ? 8000 : mediumAnswer ? 1200 : longAnswer ? 2000 : 3000;\n            // Require stop button to disappear before treating completion as final.\n            if (!stopVisible) {\n                const stableEnough = stableCycles >= requiredStableCycles && stableMs >= minStableMs;\n                const completionEnough = completionVisible && stableCycles >= completionStableTarget && stableMs >= minStableMs;\n                if (completionEnough || stableEnough) {\n                    return normalized;\n                }\n            }",
    replace: "            const completionStableTarget = shortAnswer ? 12 : mediumAnswer ? 8 : longAnswer ? 6 : 8;\n            const requiredStableCycles = shortAnswer ? 12 : mediumAnswer ? 8 : longAnswer ? 8 : 10;\n            const stableMs = Date.now() - lastChangeAt;\n            const minStableMs = shortAnswer ? 8000 : mediumAnswer ? 1200 : longAnswer ? 2000 : 3000;\n            const completionEnough = completionVisible && stableCycles >= completionStableTarget && stableMs >= minStableMs;\n            const stableEnough = !stopVisible && stableCycles >= requiredStableCycles && stableMs >= minStableMs;\n            if (completionEnough || stableEnough) {\n                return normalized;\n            }"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/sessionRunner.js",
    search: "    const automationLogger = ((message) => {\n        if (typeof message !== 'string')\n            return;\n        const shouldAlwaysPrint = message.startsWith('[browser] ') && /fallback|retry/i.test(message);\n        if (!runOptions.verbose && !shouldAlwaysPrint)\n            return;\n        log(message);\n    });",
    replace: "    const automationLogger = ((message) => {\n        if (typeof message !== 'string')\n            return;\n        const shouldAlwaysPrint = (message.startsWith('[browser] ') && /fallback|retry/i.test(message)) ||\n            message.startsWith('[browser-step] ') ||\n            message.startsWith('[assistant-preview] ') ||\n            /^\\d+%\\s+\\[[^\\]]+\\]\\s+—\\s+.+$/.test(message);\n        if (!runOptions.verbose && !shouldAlwaysPrint)\n            return;\n        log(message);\n    });"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/sessionRunner.js",
    search: "        runtime: {\n            chromePid: browserResult.chromePid,\n            chromePort: browserResult.chromePort,\n            chromeHost: browserResult.chromeHost,\n            userDataDir: browserResult.userDataDir,\n            controllerPid: browserResult.controllerPid ?? process.pid,\n        },",
    replace: "        runtime: {\n            chromePid: browserResult.chromePid,\n            chromePort: browserResult.chromePort,\n            chromeHost: browserResult.chromeHost,\n            userDataDir: browserResult.userDataDir,\n            chromeTargetId: browserResult.chromeTargetId,\n            tabUrl: browserResult.tabUrl,\n            conversationId: browserResult.tabUrl && browserResult.tabUrl.includes('/c/')\n                ? browserResult.tabUrl.split('/c/')[1]?.split(/[?#]/)[0]\n                : undefined,\n            controllerPid: browserResult.controllerPid ?? process.pid,\n        },"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/providerDomFlow.js",
    search:
      "export async function runProviderSubmissionFlow(adapter, ctx) {\n    await adapter.waitForUi(ctx);\n    if (adapter.selectMode) {\n        await adapter.selectMode(ctx);\n    }\n    await adapter.typePrompt(ctx);\n    await adapter.submitPrompt(ctx);\n}",
    replace:
      "export async function runProviderSubmissionFlow(adapter, ctx) {\n    ctx.log?.('[browser-step] provider.waitForUi:start');\n    await adapter.waitForUi(ctx);\n    ctx.log?.('[browser-step] provider.waitForUi:done');\n    if (adapter.selectMode) {\n        ctx.log?.('[browser-step] provider.selectMode:start');\n        await adapter.selectMode(ctx);\n        ctx.log?.('[browser-step] provider.selectMode:done');\n    }\n    ctx.log?.('[browser-step] provider.typePrompt:start');\n    await adapter.typePrompt(ctx);\n    ctx.log?.('[browser-step] provider.typePrompt:done');\n    ctx.log?.('[browser-step] provider.submitPrompt:start');\n    await adapter.submitPrompt(ctx);\n    ctx.log?.('[browser-step] provider.submitPrompt:done');\n}"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search:
      "        const submitOnce = async (prompt, submissionAttachments) => {\n            const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);",
    replace:
      "        const submitOnce = async (prompt, submissionAttachments) => {\n            logger('[browser-step] submitOnce:start');\n            const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search:
      "            if (submissionAttachments.length > 0) {\n                if (!DOM) {",
    replace:
      "            if (submissionAttachments.length > 0) {\n                logger(`[browser-step] attachments:start count=${submissionAttachments.length}`);\n                if (!DOM) {"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search:
      "                    await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);\n                    logger('All attachments uploaded');",
    replace:
      "                    await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);\n                    logger('All attachments uploaded');\n                    logger('[browser-step] attachments:done');"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search:
      "            await runProviderSubmissionFlow(chatgptDomProvider, {\n                prompt,\n                evaluate: async () => undefined,\n                delay,\n                log: logger,\n                state: providerState,\n            });",
    replace:
      "            logger(`[browser-step] provider:start attachments=${sendAttachmentNames.length}`);\n            await runProviderSubmissionFlow(chatgptDomProvider, {\n                prompt,\n                evaluate: async () => undefined,\n                delay,\n                log: logger,\n                state: providerState,\n            });\n            logger('[browser-step] provider:done');"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search:
      "            // Reattach needs a /c/ URL; ChatGPT can update it late, so poll in the background.\n            scheduleConversationHint('post-submit', config.timeoutMs ?? 120_000);\n            return { baselineTurns, baselineAssistantText };",
    replace:
      "            // Reattach needs a /c/ URL; ChatGPT can update it late, so poll in the background.\n            scheduleConversationHint('post-submit', config.timeoutMs ?? 120_000);\n            logger('[browser-step] submitOnce:done');\n            return { baselineTurns, baselineAssistantText };"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search:
      "        await captureRuntimeSnapshot();\n        const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;\n        if (config.desiredModel && modelStrategy !== 'ignore') {\n            await raceWithDisconnect(withRetries(() => ensureModelSelection(Runtime, config.desiredModel, logger, modelStrategy), {",
    replace:
      "        await captureRuntimeSnapshot();\n        const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;\n        if (config.desiredModel && modelStrategy !== 'ignore') {\n            logger('[browser-step] modelSelection:start');\n            await raceWithDisconnect(withRetries(() => ensureModelSelection(Runtime, config.desiredModel, logger, modelStrategy), {"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search:
      "            })).catch((error) => {\n                const base = error instanceof Error ? error.message : String(error);\n                const hint = appliedCookies === 0\n                    ? ' No cookies were applied; log in to ChatGPT in Chrome or provide inline cookies (--browser-inline-cookies[(-file)] or ORACLE_BROWSER_COOKIES_JSON).'\n                    : '';\n                throw new Error(`${base}${hint}`);\n            });\n            await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));",
    replace:
      "            })).catch((error) => {\n                const base = error instanceof Error ? error.message : String(error);\n                const hint = appliedCookies === 0\n                    ? ' No cookies were applied; log in to ChatGPT in Chrome or provide inline cookies (--browser-inline-cookies[(-file)] or ORACLE_BROWSER_COOKIES_JSON).'\n                    : '';\n                throw new Error(`${base}${hint}`);\n            });\n            logger('[browser-step] modelSelection:done');\n            logger('[browser-step] promptReadyAfterModel:start');\n            await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));\n            logger('[browser-step] promptReadyAfterModel:done');"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search:
      "        // Handle thinking time selection if specified\n        const thinkingTime = config.thinkingTime;\n        if (thinkingTime) {\n            await raceWithDisconnect(withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {",
    replace:
      "        // Handle thinking time selection if specified\n        const thinkingTime = config.thinkingTime;\n        if (thinkingTime) {\n            logger(`[browser-step] thinkingTime:start ${thinkingTime}`);\n            await raceWithDisconnect(withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {"
  },
  {
    relativePath: "node_modules/@steipete/oracle/dist/src/browser/index.js",
    search:
      "            }));\n        }\n        const profileLockTimeoutMs = manualLogin ? (config.profileLockTimeoutMs ?? 0) : 0;",
    replace:
      "            }));\n            logger(`[browser-step] thinkingTime:done ${thinkingTime}`);\n        }\n        const profileLockTimeoutMs = manualLogin ? (config.profileLockTimeoutMs ?? 0) : 0;"
  }
];

async function main() {
  const packageJsonPath = path.join(process.cwd(), "node_modules/@steipete/oracle/package.json");

  try {
    await access(packageJsonPath);
  } catch {
    console.log("[patch-oracle] skipped: @steipete/oracle is not installed");
    return;
  }

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    version?: string;
  };

  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(
      `[patch-oracle] expected @steipete/oracle ${EXPECTED_VERSION}, found ${packageJson.version ?? "unknown"}`
    );
  }

  let patchedCount = 0;

  for (const replacement of replacements) {
    const filePath = path.join(process.cwd(), replacement.relativePath);
    const source = await readFile(filePath, "utf8");
    const isPromptComposerPatch =
      replacement.relativePath === "node_modules/@steipete/oracle/dist/src/browser/actions/promptComposer.js";
    const isModelSelectionPatch =
      replacement.relativePath === "node_modules/@steipete/oracle/dist/src/browser/actions/modelSelection.js";
    const promptComposerAlreadyPatched =
      isPromptComposerPatch &&
      (source.includes("prompt-not-in-composer") || source.includes("normalizePromptText"));
    const modelSelectionAlreadyPatched =
      isModelSelectionPatch &&
      source.includes("const collectComposerModeLabels = () => {") &&
      source.includes("const currentUiMatchesTarget = () => buttonMatchesTarget() || composerReflectsTarget();");

    if (replacement.replaceAll) {
      if (promptComposerAlreadyPatched || modelSelectionAlreadyPatched) {
        continue;
      }
      if (!source.includes(replacement.search)) {
        if (source.includes(replacement.replace)) {
          continue;
        }

        throw new Error(`[patch-oracle] could not find target snippet in ${replacement.relativePath}`);
      }

      await writeFile(
        filePath,
        source.split(replacement.search).join(replacement.replace),
        "utf8"
      );
      patchedCount += 1;
      continue;
    }

    if (promptComposerAlreadyPatched || modelSelectionAlreadyPatched) {
      continue;
    }

    if (source.includes(replacement.replace)) {
      continue;
    }

    if (!source.includes(replacement.search)) {
      throw new Error(`[patch-oracle] could not find target snippet in ${replacement.relativePath}`);
    }

    await writeFile(filePath, source.replace(replacement.search, replacement.replace), "utf8");
    patchedCount += 1;
  }

  const browserIndexPath = path.join(process.cwd(), "node_modules/@steipete/oracle/dist/src/browser/index.js");
  const browserIndexSource = await readFile(browserIndexPath, "utf8");
  const normalizedBrowserIndex = browserIndexSource
    .replace(/(?:\n\s*let stopAssistantPreviewMonitor = null;){2,}/g, "\n    let stopAssistantPreviewMonitor = null;")
    .replace(
      /(?:\n\s*stopAssistantPreviewMonitor = startAssistantPreviewMonitor\(Runtime, logger, promptText, baselineTurns \?\? undefined\);){2,}/g,
      "\n        stopAssistantPreviewMonitor = startAssistantPreviewMonitor(Runtime, logger, promptText, baselineTurns ?? undefined);"
    )
    .replace(/(?:\n\s*stopAssistantPreviewMonitor\?\.\(\);){2,}/g, "\n        stopAssistantPreviewMonitor?.();")
    .replace(
      /(function startAssistantPreviewMonitor\(Runtime, logger, promptText, minTurnIndex\) \{[\s\S]*?function summarizeAssistantPreview\(raw, promptEchoMatcher\) \{[\s\S]*?\n\}\n)(function startAssistantPreviewMonitor\(Runtime, logger, promptText, minTurnIndex\) \{[\s\S]*?function summarizeAssistantPreview\(raw, promptEchoMatcher\) \{[\s\S]*?\n\}\n)(?=async function readThinkingStatus)/,
      "$1"
    );

  if (normalizedBrowserIndex !== browserIndexSource) {
    await writeFile(browserIndexPath, normalizedBrowserIndex, "utf8");
  }

  const modelSelectionPath = path.join(
    process.cwd(),
    "node_modules/@steipete/oracle/dist/src/browser/actions/modelSelection.js"
  );
  const modelSelectionSource = await readFile(modelSelectionPath, "utf8");
  const normalizedModelSelection = modelSelectionSource
    .replace(
      "    const button = document.querySelector(BUTTON_SELECTOR);\n    if (!button) {\n      return { status: 'button-missing' };\n    }\n\n    const closeMenu = () => {",
      "    const button = document.querySelector(BUTTON_SELECTOR);\n    if (!button) {\n      return { status: 'button-missing' };\n    }\n\n    const isVisibleNode = (node) => {\n      if (!(node instanceof HTMLElement) || typeof node.getBoundingClientRect !== 'function') {\n        return false;\n      }\n      const rect = node.getBoundingClientRect();\n      return rect.width > 0 && rect.height > 0;\n    };\n    const hasVisibleMenu = () => Array.from(document.querySelectorAll(${menuContainerLiteral})).some((node) => isVisibleNode(node));\n    const collectComposerModeLabels = () => {\n      const selectors = [\n        '[data-testid=\"composer-footer-actions\"] button.__composer-pill[aria-haspopup=\"menu\"]',\n        '[data-testid=\"composer-footer-actions\"] .__composer-pill-composite button[aria-haspopup=\"menu\"]',\n        'button.__composer-pill[aria-haspopup=\"menu\"]',\n      ];\n      return selectors\n        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))\n        .filter((node, index, arr) => arr.indexOf(node) === index)\n        .filter((node) => isVisibleNode(node))\n        .map((node) => (node?.textContent ?? '').trim())\n        .filter(Boolean);\n    };\n    const normalizeFamily = (value) => {\n      const normalized = normalizeText(value);\n      if (!normalized) {\n        return null;\n      }\n      if (normalized.includes('pro')) {\n        return 'pro';\n      }\n      if (normalized.includes('thinking')) {\n        return 'thinking';\n      }\n      if (normalized.includes('auto') || normalized.includes('instant')) {\n        return 'auto';\n      }\n      return null;\n    };\n    const desiredFamily = wantsPro ? 'pro' : wantsThinking ? 'thinking' : wantsInstant ? 'auto' : null;\n\n    const closeMenu = () => {\n      const menuExpanded = button.getAttribute?.('aria-expanded') === 'true';\n      if (!menuExpanded && !hasVisibleMenu()) {\n        return;\n      }"
    )
    .replace(
      "    const getButtonLabel = () => (button.textContent ?? '').trim();\n    if (MODEL_STRATEGY === 'current') {\n      return { status: 'already-selected', label: getButtonLabel() };\n    }",
      "    const getButtonLabel = () => (button.textContent ?? '').trim();\n    const composerReflectsTarget = () => {\n      if (!desiredFamily) {\n        return false;\n      }\n      return collectComposerModeLabels().some((label) => normalizeFamily(label) === desiredFamily);\n    };\n    const currentUiMatchesTarget = () => buttonMatchesTarget() || composerReflectsTarget();\n    const describeCurrentSelection = () => {\n      if (buttonMatchesTarget()) {\n        return getButtonLabel();\n      }\n      const composerLabel = collectComposerModeLabels().find((label) => normalizeFamily(label) === desiredFamily);\n      return composerLabel ?? getButtonLabel() ?? PRIMARY_LABEL;\n    };\n    if (MODEL_STRATEGY === 'current') {\n      return { status: 'already-selected', label: getButtonLabel() };\n    }"
    )
    .replace(
      "    if (buttonMatchesTarget()) {\n      return { status: 'already-selected', label: getButtonLabel() };\n    }",
      "    if (currentUiMatchesTarget()) {\n      return { status: 'already-selected', label: describeCurrentSelection() };\n    }"
    )
    .replace(
      "      const menus = Array.from(document.querySelectorAll(${menuContainerLiteral}));\n      for (const menu of menus) {\n        const buttons = Array.from(menu.querySelectorAll(${menuItemLiteral}));",
      "      const menus = Array.from(document.querySelectorAll(${menuContainerLiteral})).filter((node) => isVisibleNode(node));\n      for (const menu of menus) {\n        const buttons = Array.from(menu.querySelectorAll(${menuItemLiteral})).filter((node) => isVisibleNode(node));"
    )
    .replace(
      "      const isVisibleNode = (node) => {\n        if (!(node instanceof HTMLElement) || typeof node.getBoundingClientRect !== 'function') {\n          return false;\n        }\n        const rect = node.getBoundingClientRect();\n        return rect.width > 0 && rect.height > 0;\n      };\n      const collectVisibleMenuText = () => {",
      "      const collectVisibleMenuText = () => {"
    )
    .replace(
      "      const ensureMenuOpen = () => {\n        const menuOpen = document.querySelector('[role=\"menu\"], [data-radix-collection-root]');\n        if (!menuOpen && performance.now() - lastPointerClick > REOPEN_INTERVAL_MS) {",
      "      const ensureMenuOpen = () => {\n        const menuOpen = hasVisibleMenu() || button.getAttribute?.('aria-expanded') === 'true';\n        if (!menuOpen && performance.now() - lastPointerClick > REOPEN_INTERVAL_MS) {"
    )
    .replace(
      "          if (optionIsSelected(match.node)) {\n            closeMenu();\n            resolve({ status: 'already-selected', label: getButtonLabel() || match.label });\n            return;\n          }",
      "          if (optionIsSelected(match.node)) {\n            closeMenu();\n            resolve({ status: 'already-selected', label: describeCurrentSelection() || match.label });\n            return;\n          }"
    )
    .replace(
      "          // Wait for the top bar label to reflect the requested model; otherwise keep scanning.\n          setTimeout(() => {\n            if (buttonMatchesTarget()) {\n              closeMenu();\n              resolve({ status: 'switched', label: getButtonLabel() || match.label });\n              return;\n            }\n            attempt();\n          }, Math.max(120, INITIAL_WAIT_MS));",
      "          // Wait for the current UI to reflect the requested model family; otherwise keep scanning.\n          setTimeout(() => {\n            if (currentUiMatchesTarget()) {\n              closeMenu();\n              resolve({ status: 'switched', label: describeCurrentSelection() || match.label });\n              return;\n            }\n            const selectedMatch = findBestOption();\n            if (selectedMatch && optionIsSelected(selectedMatch.node)) {\n              closeMenu();\n              resolve({ status: 'switched', label: selectedMatch.label || match.label });\n              return;\n            }\n            attempt();\n          }, Math.max(120, INITIAL_WAIT_MS));"
    );

  if (normalizedModelSelection !== modelSelectionSource) {
    await writeFile(modelSelectionPath, normalizedModelSelection, "utf8");
  }

  const promptComposerPath = path.join(
    process.cwd(),
    "node_modules/@steipete/oracle/dist/src/browser/actions/promptComposer.js"
  );
  const promptComposerSource = await readFile(promptComposerPath, "utf8");
  const normalizedPromptComposer = promptComposerSource
    .replace(
      "    const promptPresentAfterForceInsert = matchesPrompt(observedEditor) || matchesPrompt(observedFallback) || matchesPrompt(observedActive);",
      "    const promptPresentAfterForceInsert = matchesPrompt(observedActive) || matchesPrompt(observedEditor);"
    )
    .replace(
      "          } else {\n            active.textContent = ${encodedPrompt};\n            active.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));\n          }",
      "          } else {\n            if (typeof active.focus === 'function') {\n              active.focus();\n            }\n            if (active.isContentEditable) {\n              const selection = active.ownerDocument?.getSelection?.();\n              if (selection) {\n                const range = active.ownerDocument.createRange();\n                range.selectNodeContents(active);\n                range.collapse(false);\n                selection.removeAllRanges();\n                selection.addRange(range);\n              }\n            }\n            active.innerText = ${encodedPrompt};\n            active.textContent = ${encodedPrompt};\n            active.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));\n            active.dispatchEvent(new Event('change', { bubbles: true }));\n          }"
    );

  if (normalizedPromptComposer !== promptComposerSource) {
    await writeFile(promptComposerPath, normalizedPromptComposer, "utf8");
  }

  console.log(`[patch-oracle] applied ${patchedCount} patch${patchedCount === 1 ? "" : "es"}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
