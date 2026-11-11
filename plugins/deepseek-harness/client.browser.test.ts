import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { embeddedDocument } from './runtime.js'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'

let browser: Browser
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  const clientPath = fileURLToPath(new URL('./client.js', import.meta.url))
  const webDir = fileURLToPath(new URL('.', import.meta.url))
  const build = await Bun.build({
    entrypoints: ['beeftv-client-harness'],
    target: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'client-harness', setup(builder) {
      builder.onResolve({ filter: /^beeftv-client-harness$/ }, () => ({ path: 'entry', namespace: 'harness' }))
      builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
        loader: 'js',
        resolveDir: webDir,
        contents: `
          import React from ${JSON.stringify(Bun.resolveSync('react', webDir))};
          import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', webDir))};
          const h = React.createElement;
          const components = new Map();
          function NativeView({ options }) {
            React.useEffect(() => { window.nativeMounts = (window.nativeMounts || 0) + 1; }, []);
            window.nativeOptions = { variant: options.variant, hero: options.hero, phase: options.phase };
            return h('div', { 'data-native-conversation': true }, 'Native conversation');
          }
          window.__ModuleLoader__ = { load({ factory }) {
            const services = { conversation: { input: { requestDraftInitialization: (binding, options) => {
              window.lastDraft = { sessionId: binding.sessionId, options };
              return window.__draftStatus || 'applied';
            } } } };
            if (window.__noConversation) delete services.conversation;
            factory(name => { if (name === 'react') return React; throw new Error(name); }).apply({
              effect: effect => effect(),
              get: name => services[name],
              sessions: {
                create: async () => {
                  if (window.__createFails) throw new Error('无法新建会话');
                  return 'created-session';
                },
                binding: id => ({ sessionId: id }),
              },
              uiWorkspace: {
                openSession(id) { window.openedSession = id; },
                ...(window.__noStartSession ? {} : { startSession(workspaceId, options) { window.startedSession = { workspaceId, options }; } }),
              },
              layout: { selectPanel: id => { window.selectedPanel = id; } },
              slots: {
                inject: (name, register) => register(),
                register: (config, component) => {
                  if (config.inject) window.__mainInject = config.inject();
                  components.set(config.name, component);
                },
              },
            });
          }};
          await import(${JSON.stringify(clientPath)});
          function Shell() {
            const [sessionId, setSessionId] = React.useState(window.__noSession ? undefined : 'native-session');
            window.__setSessionId = setSessionId;
            window.__renderedSession = sessionId;
            const useSession = () => ({ openState: 'ready' });
            const renderSlot = (name, props) => h(components.get(name), {
              ...props, sessionId, useSession,
              renderFactorySlot: (name, options) => h(NativeView, { options }),
            });
            return h(components.get('main'), {
              ...window.__mainInject, renderSlot, returnToConversation() {},
              async createCreativeSession() { window.createdSessions = (window.createdSessions || 0) + 1; },
            });
          }
          createRoot(document.getElementById('root')).render(h(Shell));
        `,
      }))
    } }],
  })
  if (!build.success) throw new Error(build.logs.join('\n'))
  const script = await build.outputs[0].text()
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/client.js') return new Response(script, { headers: { 'content-type': 'text/javascript' } })
    if (path.startsWith('/workspace/')) return new Response(embeddedDocument('<html><head></head><body style="margin:0"><div class="canvas-topbar" style="position:absolute;inset:0 0 auto;display:flex;height:48px;box-sizing:border-box"><button>Canvas menu</button></div><div class="app-user-workspace"><button class="app-workspace-floating-menu" style="position:absolute;top:60px">Page menu</button></div><main style="position:absolute;top:120px;left:0;width:100%">Workspace</main></body></html>', '/beeftv/app/fixture'), { headers: { 'content-type': 'text/html' } })
    return new Response('<html><style>html,body,#root{height:100%;margin:0}body{--dsw-font-family:system-ui;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#777;--dsw-alias-border-l2:#ddd}</style><div id="root"></div><script type="module" src="/client.js"></script></html>', { headers: { 'content-type': 'text/html' } })
  } })
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => path && existsSync(path))
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true })
}, 30_000)

afterAll(async () => { await browser?.close(); server?.stop(true) })

async function openWorkbench(options: { hidden?: boolean; clock?: boolean; init?: () => void } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  if (options.clock) await page.clock.install()
  if (options.init) await page.addInitScript(options.init)
  if (options.hidden) await page.addInitScript(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }))
  let status = { connected: true, connectionId: 'connection-local', mode: 'local', version: '2.1.6', appURL: new URL('/workspace/local/', server.url).href }
  let reads = 0
  const contexts: Array<Record<string, any>> = []
  const prompts: Array<Record<string, any>> = []
  await page.route('**/beeftv/status', async route => {
    reads += 1
    await route.fulfill({ json: status })
  })
  await page.route('**/beeftv/context', async route => {
    contexts.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true } })
  })
  await page.route('**/beeftv/local-prompt', async route => {
    prompts.push(route.request().postDataJSON())
    status = { ...status, localPromptDismissed: true }
    await route.fulfill({ json: status })
  })
  await page.goto(server.url.href)
  await page.locator('iframe').waitFor()
  await page.frameLocator('iframe').getByText('Workspace', { exact: true }).waitFor()
  return { page, contexts, prompts, reads: () => reads, setStatus: (next: typeof status) => { status = next }, status: () => status }
}

function workspaceFrame(page: Page) {
  return page.frames().find(frame => frame.url().includes('/workspace/'))!
}

async function sendAsk(page: Page, ask: Record<string, any>) {
  const workspace = workspaceFrame(page)
  await workspace.evaluate(message => parent.postMessage(message, location.origin), { type: 'beeftv:ask', ask })
  await workspace.waitForFunction(() => (window as any).askResult !== undefined)
  const result = await workspace.evaluate(() => (window as any).askResult)
  await workspace.evaluate(() => { (window as any).askResult = undefined })
  return result as string
}

async function listenAskResults(page: Page) {
  await workspaceFrame(page).evaluate(() => {
    (window as any).askResult = undefined
    window.addEventListener('message', event => {
      if ((event.data as any)?.type === 'beeftv:ask-result') (window as any).askResult = (event.data as any).status
    })
  })
}

async function refresh(page: Page) {
  const response = page.waitForResponse('**/beeftv/status')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await response
}

test('BeefTV Agent keeps the native conversation and sends the selected collaboration mode', async () => {
  const state = await openWorkbench()
  const { page, contexts } = state
  expect(await page.getByRole('heading', { name: 'BeefTV Agent' }).count()).toBe(1)
  expect(await page.getByText('当前会话', { exact: true }).count()).toBe(0)
  expect(await page.getByRole('complementary', { name: 'BeefTV Agent' }).evaluate(element => element.getBoundingClientRect().width)).toBe(432)
  await page.getByRole('button', { name: '素材', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[title="整理与复用创作素材"]')?.getAttribute('aria-pressed') === 'true')
  await page.waitForTimeout(30)
  expect(contexts.at(-1)?.agentMode).toBe('assets')
  expect(contexts.every(report => report.connectionId === 'connection-local')).toBe(true)
  expect(await page.evaluate(() => (window as any).nativeOptions)).toEqual({ variant: 'embedded', hero: false, phase: 'active' })
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.frameLocator('iframe').locator('body').evaluate(element => {
    element.ownerDocument.defaultView!.addEventListener('message', event => {
      if (event.data?.type === 'beeftv:workspace-sync') (element.ownerDocument.defaultView as any).lastWorkspaceSync = event.data.activity
    })
  })
  state.setStatus({ ...state.status(), activity: { seq: 1, kind: 'canvas-created', canvasId: 'canvas-new' } } as any)
  await refresh(page)
  expect(await page.frameLocator('iframe').locator('body').evaluate(element => (element.ownerDocument.defaultView as any).lastWorkspaceSync)).toEqual({ seq: 1, kind: 'canvas-created', canvasId: 'canvas-new' })
  await page.close()
})

test('focus and polling preserve an unchanged iframe and native session', async () => {
  const { page, reads } = await openWorkbench()
  await page.locator('iframe').evaluate(element => { element.dataset.retained = 'yes' })
  await page.frameLocator('iframe').locator('body').evaluate(element => { (element.ownerDocument.defaultView as any).retained = true })
  await refresh(page)
  const visibleResponse = page.waitForResponse('**/beeftv/status')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await visibleResponse
  const afterFocus = reads()
  await page.waitForResponse('**/beeftv/status', { timeout: 6500 })
  expect(reads()).toBeGreaterThan(afterFocus)
  expect(await page.locator('iframe').getAttribute('data-retained')).toBe('yes')
  expect(await page.frameLocator('iframe').locator('body').evaluate(element => (element.ownerDocument.defaultView as any).retained)).toBe(true)
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.close()
}, 10_000)

test('a changed workspace source clears old canvas context while retaining the native conversation', async () => {
  const state = await openWorkbench()
  const { page } = state
  const workspace = page.frames().find(frame => frame.url().includes('/workspace/local/'))!
  await page.locator('iframe').evaluate(element => { (window as any).previousWorkspaceWindow = element.contentWindow })
  await workspace.evaluate(() => parent.postMessage({ type: 'beeftv:context', context: { route: '/canvas/old', canvasId: 'old', canvasTitle: 'Old canvas', selectedNodeIds: ['n1'] } }, location.origin))
  await page.getByText('Old canvas', { exact: true }).waitFor()
  const newReport = page.waitForRequest(request => request.url().endsWith('/beeftv/context') && request.postDataJSON().connectionId === 'connection-next')
  state.setStatus({ ...state.status(), connectionId: 'connection-next', mode: 'standalone', appURL: new URL('/workspace/standalone/', server.url).href })
  await refresh(page)
  const report = (await newReport).postDataJSON()
  expect(report.context).toEqual({ route: '/', selectedNodeIds: [] })
  await page.waitForFunction(() => document.querySelector('iframe')?.getAttribute('src')?.includes('/workspace/standalone/'))
  expect(await page.getByText('Old canvas', { exact: true }).count()).toBe(0)
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    source: (window as any).previousWorkspaceWindow,
    origin: location.origin,
    data: { type: 'beeftv:context', context: { route: '/canvas/late', canvasTitle: 'Stale late canvas', selectedNodeIds: [] } },
  })))
  await page.waitForTimeout(30)
  expect(await page.getByText('Stale late canvas', { exact: true }).count()).toBe(0)
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.close()
})

test('a rejected old connection refreshes status silently while other context failures remain visible', async () => {
  const state = await openWorkbench()
  const { page } = state
  let rejection = 409
  await page.route('**/beeftv/context', route => route.fulfill({ status: rejection, json: { error: 'Context request failed' } }))
  const refreshed = page.waitForResponse('**/beeftv/status')
  await page.getByRole('button', { name: '素材', exact: true }).click()
  await refreshed
  expect(await page.getByRole('alert').count()).toBe(0)
  rejection = 500
  await page.getByRole('button', { name: '生态', exact: true }).click()
  await page.getByRole('alert').waitFor()
  expect(await page.getByRole('alert').textContent()).toBe('Context request failed')
  await page.close()
})

test('workspace selection stays open across refresh and an in-flight connect rejects stale status', async () => {
  const state = await openWorkbench()
  const { page } = state
  await page.getByRole('button', { name: '工作台操作' }).click()
  await page.getByRole('button', { name: '切换工作区' }).click()
  await refresh(page)
  expect(await page.getByRole('button', { name: '使用独立工作区' }).count()).toBe(1)
  let release!: () => void
  await page.route('**/beeftv/connect', async route => {
    await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ json: { ...state.status(), mode: 'standalone', appURL: new URL('/workspace/standalone/', server.url).href } })
  })
  await page.getByRole('button', { name: '使用独立工作区' }).click()
  const reads = state.reads()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(50)
  expect(state.reads()).toBe(reads)
  release()
  await page.waitForFunction(() => document.querySelector('iframe')?.getAttribute('src')?.includes('/workspace/standalone/'))
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.close()
})

test('the toolbar is removed and resizing preserves the workspace and native chat within both width limits', async () => {
  const { page } = await openWorkbench()
  expect(await page.locator('.beeftv-harness-toolbar').count()).toBe(0)
  expect(await page.locator('.beeftv-harness-workspace').evaluate(element => element.getBoundingClientRect().top)).toBe(0)
  await page.locator('iframe').evaluate(element => { element.dataset.retained = 'yes' })
  const separator = page.getByRole('separator', { name: '调整 BeefTV Agent 宽度' })
  const pane = page.getByRole('complementary', { name: 'BeefTV Agent' })
  const bounds = await separator.boundingBox()
  if (!bounds) throw new Error('Missing resize handle')
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 120, y, { steps: 6 })
  expect(await pane.evaluate(element => element.getBoundingClientRect().width)).toBe(552)
  await page.mouse.move(1270, y, { steps: 8 })
  await page.mouse.up()
  expect(await pane.evaluate(element => element.getBoundingClientRect().width)).toBe(320)
  expect(await page.locator('.beeftv-harness').getAttribute('data-resizing')).toBe('false')
  await separator.press('ArrowLeft')
  expect(await pane.evaluate(element => element.getBoundingClientRect().width)).toBe(336)
  const current = await separator.boundingBox()
  await page.mouse.move(current!.x + 3, y)
  await page.mouse.down()
  await page.mouse.move(0, y, { steps: 8 })
  await page.mouse.up()
  expect(await page.locator('.beeftv-harness-workspace').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(280)
  await page.setViewportSize({ width: 600, height: 900 })
  await page.waitForFunction(() => document.querySelector('[aria-label="BeefTV Agent"]')?.getBoundingClientRect().width === 320)
  expect(await page.locator('iframe').getAttribute('data-retained')).toBe('yes')
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.getByRole('button', { name: '工作台操作' }).click()
  await page.getByRole('button', { name: '新建会话', exact: true }).click()
  expect(await page.evaluate(() => (window as any).createdSessions)).toBe(1)
  await page.close()
})

test('the workspace follows host window-control clearance across sidebar and fullscreen states', async () => {
  const { page } = await openWorkbench()
  await page.locator('iframe').evaluate(element => { element.dataset.retained = 'yes' })
  for (const clearance of [160, 84, 48, 0, 160, 0]) {
    await page.evaluate(value => document.documentElement.style.setProperty('--dsh-frame-leading-clearance', `${value}px`), clearance)
    await page.waitForFunction(value => document.querySelector('iframe')?.contentDocument?.documentElement.style.getPropertyValue('--beeftv-host-leading') === `${value}px`, clearance)
    expect(await page.locator('iframe').evaluate(element => element.getBoundingClientRect().left)).toBe(0)
    expect(await page.frameLocator('iframe').getByRole('button', { name: 'Canvas menu' }).evaluate(element => element.getBoundingClientRect().left)).toBe(clearance + 8)
    expect(await page.frameLocator('iframe').getByRole('main').evaluate(element => element.getBoundingClientRect().left)).toBe(0)
    expect(await page.locator('iframe').evaluate(element => element.getBoundingClientRect().top)).toBe(0)
    expect(await page.locator('iframe').getAttribute('data-retained')).toBe('yes')
    expect(await page.getByRole('complementary', { name: 'BeefTV Agent' }).evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(320)
  }
  await page.setViewportSize({ width: 600, height: 900 })
  await page.evaluate(() => document.documentElement.style.setProperty('--dsh-frame-leading-clearance', '84px'))
  await page.waitForFunction(() => document.querySelector('[aria-label="BeefTV Agent"]')?.getBoundingClientRect().width === 320)
  expect(await page.locator('iframe').evaluate(element => element.getBoundingClientRect().left)).toBe(0)
  expect(await page.locator('.beeftv-harness').evaluate(element => element.getBoundingClientRect().right)).toBe(600)
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.close()
})

test('hidden mounts read status once and keep subsequent hidden polling idle', async () => {
  const { page, reads } = await openWorkbench({ hidden: true, clock: true })
  expect(reads()).toBe(1)
  expect(await page.getByText('正在读取本机连接状态…', { exact: true }).count()).toBe(0)
  await page.clock.fastForward(15_000)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(reads()).toBe(1)
  await page.close()
})

test('an outdated local App shows its upgrade requirement and is connected only after it passes the check', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const upgrade = '本机 BeefTV 版本为 2.1.6，需要 2.2.0 或更高版本。请升级后重新连接。'
  let status: Record<string, any> = { connected: false, mode: null, switching: false, error: null, connectionId: null, localApp: { compatible: false, version: '2.1.6', message: upgrade } }
  const connects: Array<Record<string, any>> = []
  await page.route('**/beeftv/status', route => route.fulfill({ json: status }))
  await page.route('**/beeftv/connect', async route => {
    connects.push(route.request().postDataJSON())
    await route.fulfill({ json: { connected: true, connectionId: 'connection-local', mode: 'local', appURL: new URL('/workspace/local/', server.url).href } })
  })
  await page.route('**/beeftv/context', route => route.fulfill({ json: { ok: true } }))
  await page.goto(server.url.href)
  await page.getByRole('button', { name: /连接本机 BeefTV/ }).getByText(upgrade, { exact: true }).waitFor()
  await refresh(page)
  expect(connects).toEqual([])
  expect(await page.getByRole('alert').count()).toBe(0)
  status = { ...status, localApp: { compatible: true, version: '2.2.0', message: null } }
  await refresh(page)
  await page.frameLocator('iframe').getByText('Workspace', { exact: true }).waitFor()
  expect(connects).toEqual([{ mode: 'local' }])
  await page.close()
})

test('a timed-out status read reports failure and releases polling for a successful retry', async () => {
  const page = await browser.newPage()
  await page.addInitScript(() => {
    const runtime = window as Window & { statusAttempts: number; expireStatus?: () => void; pollStatus?: () => void }
    const originalFetch = window.fetch.bind(window)
    const originalTimeout = window.setTimeout.bind(window)
    const originalInterval = window.setInterval.bind(window)
    window.setTimeout = ((handler, delay, ...args) => {
      if (delay === 10_000 && typeof handler === 'function') runtime.expireStatus = handler as () => void
      return originalTimeout(handler, delay, ...args)
    }) as typeof window.setTimeout
    window.setInterval = ((handler, delay, ...args) => {
      if (delay === 5000 && typeof handler === 'function') runtime.pollStatus = handler as () => void
      return originalInterval(handler, delay, ...args)
    }) as typeof window.setInterval
    runtime.statusAttempts = 0
    window.fetch = (input, init) => {
      if (input === '/beeftv/status') {
        runtime.statusAttempts += 1
        if (runtime.statusAttempts === 1) {
          return new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
          })
        }
      }
      return originalFetch(input, init)
    }
  })
  await page.route('**/beeftv/status', async route => {
    await route.fulfill({ json: { connected: true, connectionId: 'retry-connection', mode: 'local', appURL: new URL('/workspace/retry/', server.url).href } })
  })
  await page.route('**/beeftv/context', route => route.fulfill({ json: { ok: true } }))
  await page.goto(server.url.href)
  await page.waitForFunction(() => (window as any).statusAttempts === 1)
  await page.evaluate(() => (window as any).expireStatus())
  await page.getByRole('alert').waitFor()
  expect(await page.getByRole('alert').textContent()).toBe('读取工作区连接超时，请重试')
  const retry = page.waitForResponse('**/beeftv/status')
  await page.evaluate(() => (window as any).pollStatus())
  await retry
  await page.locator('iframe').waitFor()
  expect(await page.evaluate(() => (window as any).statusAttempts)).toBe(2)
  expect(await page.getByRole('alert').count()).toBe(0)
  await page.close()
})

test('问助手把选中的节点预填到当前对话，不发送，并把节点写进会话上下文', async () => {
  const state = await openWorkbench()
  const { page } = state
  await listenAskResults(page)
  const posted = page.waitForRequest(request => request.url().endsWith('/beeftv/context') && request.postDataJSON()?.context?.canvasId === 'canvas-spring')
  const nodes = Array.from({ length: 7 }, (_, index) => ({ id: `n${index}`, title: `节点${index}`, type: 'image' }))
  expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'canvas-spring', canvasTitle: '春日', nodes })).toBe('applied')
  expect(await page.evaluate(() => (window as any).lastDraft)).toEqual({
    sessionId: 'native-session',
    options: { prompt: '画布「春日」中选中的：节点0、节点1、节点2、节点3、节点4 等 7 个节点\n', whenDraftExists: 'append' },
  })
  expect(await page.evaluate(() => (window as any).selectedPanel)).toBe('beeftv')
  const report = (await posted).postDataJSON()
  expect(report.context).toEqual({ route: '/', canvasId: 'canvas-spring', canvasTitle: '春日', selectedNodeIds: nodes.map(node => node.id) })
  await page.close()
})

for (const status of ['applied', 'preserved', 'blocked']) {
  test(`问助手把输入框的 ${status} 结果原样返回，不覆盖已有草稿`, async () => {
    const { page } = await openWorkbench()
    // 输入框的返回由 DSH 决定，插件只转交状态。
    await page.evaluate(value => { (window as any).__draftStatus = value }, status)
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'video' }] })).toBe(status)
    expect(await page.evaluate(() => (window as any).lastDraft.options.whenDraftExists)).toBe('append')
    await page.close()
  })
}

test('没有当前会话时新建对话并确认草稿状态，失败时不谎报成功', async () => {
  {
    const { page } = await openWorkbench({ init: () => { (window as any).__noSession = true } })
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'video' }] })).toBe('applied')
    expect(await page.evaluate(() => (window as any).lastDraft)).toEqual({
      sessionId: 'created-session',
      options: { prompt: '画布「画布」中选中的：镜头一\n', whenDraftExists: 'append' },
    })
    expect(await page.evaluate(() => (window as any).openedSession)).toBe('created-session')
    await page.close()
  }
  {
    const { page } = await openWorkbench({ init: () => { (window as any).__noSession = true; (window as any).__draftStatus = 'blocked' } })
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'image' }] })).toBe('blocked')
    await page.close()
  }
  {
    const { page } = await openWorkbench({ init: () => { (window as any).__noSession = true; (window as any).__createFails = true } })
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [] })).toBe('unavailable')
    await page.close()
  }
})

test('旧版没有输入预填接口时退回新建会话，完全不可用时回 unavailable', async () => {
  {
    const { page } = await openWorkbench({ init: () => { (window as any).__noSession = true; (window as any).__noConversation = true } })
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'video' }] })).toBe('applied')
    expect(await page.evaluate(() => (window as any).startedSession)).toEqual({
      workspaceId: undefined,
      options: { prompt: '画布「画布」中选中的：镜头一\n', whenDraftExists: 'append' },
    })
    await page.close()
  }
  {
    const { page } = await openWorkbench({ init: () => { (window as any).__noConversation = true; (window as any).__noStartSession = true } })
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [] })).toBe('unavailable')
    await page.close()
  }
})

test('切换会话后问助手写到新会话', async () => {
  const { page } = await openWorkbench()
  await listenAskResults(page)
  await page.evaluate(() => (window as any).__setSessionId('session-two'))
  await page.waitForFunction(() => (window as any).__renderedSession === 'session-two')
  expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'image' }] })).toBe('applied')
  expect(await page.evaluate(() => (window as any).lastDraft.sessionId)).toBe('session-two')
  await page.close()
})

test('不是嵌入页发来或来源不符的问助手消息会被忽略', async () => {
  const { page } = await openWorkbench()
  await listenAskResults(page)
  const ask = { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'image' }] }
  await page.evaluate(message => window.postMessage(message, location.origin), { type: 'beeftv:ask', ask })
  // 把来源伪装成嵌入页，但 origin 不是嵌入页的来源。
  await page.evaluate(message => {
    const frame = document.querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: 'https://example.invalid',
      data: message,
    }))
  }, { type: 'beeftv:ask', ask })
  await page.waitForTimeout(50)
  expect(await workspaceFrame(page).evaluate(() => (window as any).askResult)).toBeUndefined()
  expect(await page.evaluate(() => (window as any).lastDraft)).toBeUndefined()
  await page.close()
})

test('独立工作区常驻数据说明，本机可用时只提示一次并能记住暂不', async () => {
  const state = await openWorkbench()
  const { page } = state
  state.setStatus({
    ...state.status(),
    mode: 'standalone',
    appURL: new URL('/workspace/standalone/', server.url).href,
    localApp: { compatible: true, version: '2.2.0', message: null },
    localPromptDismissed: false,
  } as any)
  await refresh(page)
  const note = '独立工作区，和本机 BeefTV 不是同一份数据'
  const offer = '本机 BeefTV 可以连接了，连接后用同一份画布和素材。'
  await page.getByText(note, { exact: true }).waitFor()
  await page.getByText(offer, { exact: true }).waitFor()
  await page.getByRole('button', { name: '暂不' }).click()
  await page.waitForFunction(text => !document.body.innerText.includes(text), offer)
  expect(state.prompts).toEqual([{ dismissed: true }])
  expect(await page.getByText(note, { exact: true }).count()).toBe(1)
  await refresh(page)
  await page.waitForTimeout(30)
  expect(await page.getByText(offer, { exact: true }).count()).toBe(0)
  expect(await page.getByText(note, { exact: true }).count()).toBe(1)
  await page.close()
})

test('暂不 会丢弃还在路上的旧状态响应', async () => {
  const state = await openWorkbench()
  const { page } = state
  const offer = '本机 BeefTV 可以连接了，连接后用同一份画布和素材。'
  state.setStatus({
    ...state.status(),
    mode: 'standalone',
    appURL: new URL('/workspace/standalone/', server.url).href,
    localApp: { compatible: true, version: '2.2.0', message: null },
    localPromptDismissed: false,
  } as any)
  await refresh(page)
  await page.getByText(offer, { exact: true }).waitFor()
  let release!: () => void
  await page.route('**/beeftv/status', async route => {
    await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ json: { ...state.status(), localPromptDismissed: false } }).catch(() => {})
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  for (let index = 0; index < 100 && !release; index++) await page.waitForTimeout(10)
  expect(typeof release).toBe('function')
  await page.getByRole('button', { name: '暂不' }).click()
  release()
  await page.waitForTimeout(100)
  expect(await page.getByText(offer, { exact: true }).count()).toBe(0)
  await page.close()
})
