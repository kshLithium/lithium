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
    const withoutFooter = cleaned.replace(/\\n*\\s*NEXT_TASK:\\s*[\\s\\S]*$/i, '').trim();
    const candidate = withoutFooter || cleaned;
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
    const promptComposerAlreadyPatched =
      isPromptComposerPatch &&
      (source.includes("prompt-not-in-composer") || source.includes("normalizePromptText"));

    if (replacement.replaceAll) {
      if (promptComposerAlreadyPatched) {
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

    if (promptComposerAlreadyPatched) {
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
    .replace(/(?:\n\s*stopAssistantPreviewMonitor\?\.\(\);){2,}/g, "\n        stopAssistantPreviewMonitor?.();");

  if (normalizedBrowserIndex !== browserIndexSource) {
    await writeFile(browserIndexPath, normalizedBrowserIndex, "utf8");
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
