// DSH 前端加载器仅支持单入口模块（window.__ModuleLoader__ 只注入 react，不支持相对 require）。
window.__ModuleLoader__.load({
  id: 'dsh-beeftv',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const panelId = 'beeftv'
    const conversationSlot = 'beeftv.conversation'
    // 插件根上拿不到「当前会话」，由挂在会话里的 slot 记住，供「问助手」使用。
    let conversationSessionId
    const modes = [
      { id: 'creation', label: '创作', detail: '画布、分镜与视频创作' },
      { id: 'assets', label: '素材', detail: '整理与复用创作素材' },
      { id: 'ecosystem', label: '生态', detail: '技能、插件与工作流' },
    ]
    const portalItems = '[data-menu-material],[data-menu-backing],[role="tooltip"],[role="presentation"],[role="dialog"],[role="alert"],[class*="_portal_"],:has([data-hovercard-bridge])'
    const themedScope = sel => `html body .beeftv-harness[data-beeftv-themed] :where(${sel}), html body[data-beeftv-portal-theme][data-beeftv-portal-theme] > :where(${portalItems}) :where(${sel})`

    const css = `
.beeftv-harness { box-sizing:border-box; display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); font:14px/1.5 var(--dsw-font-family); container:beeftv-workbench / inline-size; }
.beeftv-harness-clearance { position:absolute; width:var(--dsh-frame-leading-clearance,0px); height:0; visibility:hidden; pointer-events:none; }
.beeftv-harness * { box-sizing:border-box; }
.beeftv-harness-agent-header button,.beeftv-harness-onboarding button { font:inherit; color:inherit; cursor:pointer; }
.beeftv-harness button:disabled { opacity:.5; cursor:wait; }
.beeftv-harness button:focus-visible { outline:2px solid var(--dsw-alias-link); outline-offset:2px; }
.beeftv-harness-body { display:grid; grid-template-columns:minmax(280px,1fr) 6px var(--beeftv-agent-width,432px); flex:1; min-height:0; min-width:0; overflow-x:auto; }
.beeftv-harness-divider { position:relative; cursor:col-resize; touch-action:none; outline:none; }
.beeftv-harness-divider::after { content:""; position:absolute; inset:0 2px; background:var(--dsw-alias-border-l2); }
.beeftv-harness-divider:hover::after,.beeftv-harness-divider:focus-visible::after,.beeftv-harness[data-resizing=true] .beeftv-harness-divider::after { background:var(--dsw-alias-link); }
.beeftv-harness[data-resizing=true] { cursor:col-resize; user-select:none; }
.beeftv-harness[data-resizing=true] iframe { pointer-events:none; }
.beeftv-harness-agent-title-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.beeftv-harness-actions { position:relative; }
.beeftv-harness-actions > button { border:0; border-radius:6px; width:28px; height:28px; background:transparent; }
.beeftv-harness-actions > button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-action-menu { position:absolute; right:0; top:32px; z-index:20; min-width:200px; padding:4px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)); box-shadow:0 6px 20px #0003; }
.beeftv-harness-action-menu button { display:block; width:100%; padding:8px 12px; text-align:left; border:0; border-radius:4px; background:transparent; white-space:nowrap; font-size:12px; }
.beeftv-harness-action-menu button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-action-menu button[aria-pressed=true]::after { content:"✓"; float:right; margin-left:10px; }
.beeftv-harness-setting { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 12px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.beeftv-harness-setting input { width:56px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:3px 6px; background:var(--dsw-alias-bg-base); color:inherit; font:inherit; }
.beeftv-harness-workspace { position:relative; min-width:0; min-height:0; overflow:hidden; }
.beeftv-harness-frame { display:block; width:100%; height:100%; border:0; background:var(--dsw-alias-bg-base); }
.beeftv-harness-agent { min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); --dsh-content-font-size:14px; --dsh-content-font-delta:0px; --dsh-content-font-size-secondary:12px; --dsh-content-font-delta-secondary:-1px; --dsw-font-markdown-base:14px/1.65 var(--dsw-font-family); --dsw-font-markdown-base-font-size:14px; --dsw-font-markdown-base-line-height:1.65; --dsw-font-markdown-base-strong:600 14px/1.65 var(--dsw-font-family); --dsw-font-markdown-base-italic:italic 14px/1.65 var(--dsw-font-family); --dsw-font-markdown-base-strong-italic:italic 600 14px/1.65 var(--dsw-font-family); }
.beeftv-harness-agent-header { flex:none; padding:14px 16px 10px; }
.beeftv-harness-agent-heading { margin:0; font-size:14px; line-height:22px; font-weight:600; letter-spacing:-.01em; }
.beeftv-harness-modes { display:flex; gap:3px; margin-top:10px; padding:3px; border-radius:9px; background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-agent-header .beeftv-harness-modes button { flex:1; min-width:0; border:0; border-radius:6px; padding:5px 4px; background:transparent; font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.beeftv-harness-modes button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-agent-header .beeftv-harness-modes button[aria-pressed=true] { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-markdown-code-segment-selected,var(--dsw-alias-bg-base)); box-shadow:0 1px 3px #0000001f; font-weight:500; }
.beeftv-harness-conversation { flex:1; min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden; }
.beeftv-harness-conversation > * { min-height:0; }
.beeftv-harness-context { margin-top:9px; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* Stable hooks from DSH ConversationRoot, ChatView, UserContent and InputBar. */
.beeftv-harness-agent [data-conversation-content] { --dsh-chat-content-width:100%; --dsh-composer-card-max-width:100%; --dsh-composer-side-clearance:0px; --dsh-composer-dock-inset:6px; }
.beeftv-harness-agent [data-conversation-scroll] { scrollbar-gutter:stable; }
.beeftv-harness-agent :has(> [data-message-bubble]) { max-width:92%; }
.beeftv-harness-agent [data-message-bubble] { padding:10px 12px; border-radius:12px; font-size:14px; line-height:1.65; }
.beeftv-harness-agent [data-chat-flow] h1 { font-size:18px; line-height:1.5; }
.beeftv-harness-agent [data-chat-flow] h2 { font-size:16px; line-height:1.5; }
.beeftv-harness-agent [data-chat-flow] h3 { font-size:15px; line-height:1.5; }
.beeftv-harness-agent [data-disclosure-header] { min-height:28px; font-size:12px; line-height:20px; }
.beeftv-harness-agent [data-slot="conversation.chat.node"] pre { font-size:12px; line-height:1.55; }
.beeftv-harness-agent [data-composer-seat] { --dsh-composer-text-max-height:224px; padding-top:8px; }
.beeftv-harness-agent [data-composer-card] { width:calc(100% - 24px); margin:0 auto; border-radius:12px; gap:8px; box-shadow:none; outline:1px solid var(--dsw-alias-border-l2); }
.beeftv-harness-agent [data-composer-input] { min-height:48px; padding:6px 12px 0; font-size:14px; line-height:22px; }
.beeftv-harness-agent [data-composer-placeholder] { inset-inline:12px; top:6px; font-size:14px; line-height:22px; }
.beeftv-harness-agent [data-composer-dock] { padding:3px 12px 6px; gap:8px; }
.beeftv-harness-onboarding { height:100%; display:flex; align-items:center; justify-content:center; padding:32px; }
.beeftv-harness-onboarding-content { width:100%; max-width:520px; }
.beeftv-harness-onboarding h1 { font-size:26px; margin:0 0 12px; }
.beeftv-harness-onboarding p { color:var(--dsw-alias-label-secondary); margin:0 0 24px; }
.beeftv-harness-options { display:grid; gap:12px; }
.beeftv-harness-option { display:block; width:100%; text-align:left; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); border-radius:var(--dsw-radius-md,12px); padding:16px; }
.beeftv-harness-option:hover { border-color:var(--dsw-alias-link); }
.beeftv-harness-option strong,.beeftv-harness-option span { display:block; }
.beeftv-harness-option span { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-tertiary); }
.beeftv-harness-progress { margin-top:16px; padding:12px 14px; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md,12px); background:var(--dsw-alias-bg-layer-2); font-size:12px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.beeftv-harness-progress-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.beeftv-harness-progress-row button { flex:none; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:3px 10px; background:transparent; font:inherit; color:inherit; cursor:pointer; }
.beeftv-harness-progress-row button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-progress-bar { margin-top:8px; height:4px; border-radius:999px; background:var(--dsw-alias-border-l2); overflow:hidden; }
.beeftv-harness-progress-fill { height:100%; border-radius:999px; background:var(--dsw-alias-link); transition:width .2s ease; }
.beeftv-harness-error { margin:12px 16px; color:var(--dsw-alias-label-secondary); font-size:12px; overflow-wrap:anywhere; }
.beeftv-harness-workspace-note { flex:none; padding:6px 16px; border-bottom:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.beeftv-harness-notice { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; padding:10px 16px; border-bottom:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; }
.beeftv-harness-notice span { flex:1 1 220px; min-width:0; }
.beeftv-harness-notice button { border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:4px 10px; background:transparent; font:inherit; color:inherit; cursor:pointer; }
.beeftv-harness-notice button:hover { background:var(--dsw-alias-interactive-bg-hover); }
${themedScope('*:not([class*="errorPayload"],[class*="errorPayload"] *)')} { --json-tree-property:var(--beeftv-json-property); --json-tree-string:var(--beeftv-json-string); --json-tree-number:var(--beeftv-json-number); --json-tree-keyword:var(--beeftv-json-keyword); --json-tree-punctuation:var(--beeftv-json-punctuation); --json-tree-icon:var(--beeftv-json-icon); --json-tree-hover:var(--beeftv-json-hover); --changes-fill:var(--beeftv-card-fill); --changes-hover:var(--beeftv-card-hover); --deliverable-fill:var(--beeftv-card-fill); --deliverable-hover:var(--beeftv-card-hover); --plan-card-fill:var(--beeftv-card-fill); --plan-card-hover:var(--beeftv-card-hover); --card-fill:var(--beeftv-card-fill); --card-hover:var(--beeftv-card-hover); --forge-fill:var(--beeftv-card-fill); }
${themedScope('.vdszpW_tile,.IBlBFq_fileIcon,._0K0vAa_cardIcon,.Tbt3mW_leading')} { background:var(--beeftv-card-icon-bg); }
${themedScope('[class*="_step_"][data-state="done"]')} { --dsw-alias-label-primary-foreground:var(--beeftv-step-done-fg); color:var(--beeftv-step-done-fg); }
${themedScope('[class*="_step_"][data-state="error"]')} { --dsw-alias-label-primary-foreground:var(--beeftv-step-error-fg); color:var(--beeftv-step-error-fg); }
`

    async function api(path, body, signal) {
      const response = await fetch('/beeftv/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'include',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
      const result = await response.json()
      if (!response.ok) throw Object.assign(new Error(result.error || 'BeefTV 请求失败 (' + response.status + ')'), { status: response.status, code: result.code })
      return result
    }

    function frameURL(appURL) {
      if (!appURL) return undefined
      const url = new URL(appURL, window.location.href)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('BeefTV 工作区地址无效')
      return url.href
    }

    function readWorkspaceContext(value) {
      if (!value || typeof value !== 'object' || typeof value.route !== 'string') return undefined
      return {
        route: value.route.slice(0, 2048),
        canvasId: typeof value.canvasId === 'string' ? value.canvasId.slice(0, 200) : undefined,
        canvasTitle: typeof value.canvasTitle === 'string' ? value.canvasTitle.slice(0, 300) : undefined,
        selectedNodeIds: Array.isArray(value.selectedNodeIds)
          ? value.selectedNodeIds.filter(id => typeof id === 'string').slice(0, 200).map(id => id.slice(0, 200))
          : [],
      }
    }

    // 嵌入页发来的主题事实：只接受 #hex 与受控 CSS Color 4 函数语法，拒绝一切系统色/全局关键字与延迟求值函数，再经 1x1 Canvas 光栅化校验对比度。
    let colorCanvasContext
    const allowedColorWords = new Set([
      'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
      'in', 'srgb', 'srgb-linear', 'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020', 'xyz', 'xyz-d50', 'xyz-d65',
      'shorter', 'longer', 'increasing', 'decreasing', 'hue', 'none', 'deg', 'rad', 'grad', 'turn',
    ])
    function sampleColor(raw, minAlpha = 0.5) {
      if (typeof raw !== 'string') return null
      const trimmed = raw.trim()
      if (!trimmed || trimmed.length > 64 || /[;{}<>\\\r\n]/.test(trimmed)) return null
      const isHex = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)
      if (!isHex) {
        if (!/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([\s\S]*\)$/i.test(trimmed)) return null
        const scrubbed = trimmed.replace(/#[0-9a-f]{3,8}(?![0-9a-f])/gi, '').replace(/\d(?:\.\d+)?e[+-]?\d+/gi, '')
        const words = scrubbed.match(/[a-z][a-z0-9-]*/gi) || []
        if (words.some(word => !allowedColorWords.has(word.toLowerCase()))) return null
      }
      if (typeof CSS === 'undefined' || !CSS.supports('color', trimmed) || typeof document === 'undefined') return null
      if (!colorCanvasContext) colorCanvasContext = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      if (!colorCanvasContext) return null
      colorCanvasContext.clearRect(0, 0, 1, 1)
      colorCanvasContext.fillStyle = 'rgba(0, 0, 0, 0)'
      colorCanvasContext.fillStyle = trimmed
      colorCanvasContext.fillRect(0, 0, 1, 1)
      const [r, g, b, alphaByte] = colorCanvasContext.getImageData(0, 0, 1, 1).data
      const a = alphaByte / 255
      return a >= minAlpha ? { css: trimmed, r, g, b, a } : null
    }

    function relativeLuminance(rgb) {
      const linear = [rgb.r, rgb.g, rgb.b].map(channel => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }

    const mixRgb = (base, tint, weight) => ({
      r: base.r * (1 - weight) + tint.r * weight,
      g: base.g * (1 - weight) + tint.g * weight,
      b: base.b * (1 - weight) + tint.b * weight,
      a: 1,
    })
    const compositeOver = (fg, bg) => mixRgb(bg, fg, fg.a ?? 1)
    const mixColor = (base, tint, percent) => (percent <= 0 ? base : `color-mix(in srgb, ${tint} ${percent}%, ${base})`)

    function contrastRatio(fg, bg) {
      const l1 = relativeLuminance(compositeOver(fg, bg))
      const l2 = relativeLuminance(bg)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }

    function pickReadableToken(darkHex, lightHex, surfaceDark, surfaces, selfTint = 0) {
      const check = token => surfaces.every(s => contrastRatio(token, s) >= 4.5 && (!selfTint || contrastRatio(token, mixRgb(s, token, selfTint)) >= 4.5))
      const preferred = sampleColor(surfaceDark ? darkHex : lightHex, 0.9)
      if (preferred && check(preferred)) return preferred.css
      const white = { r: 255, g: 255, b: 255, a: 1 }
      const ink = { r: 10, g: 10, b: 10, a: 1 }
      return check(white) || (!check(ink) && Math.min(...surfaces.map(s => contrastRatio(white, s))) >= Math.min(...surfaces.map(s => contrastRatio(ink, s)))) ? '#ffffff' : '#0a0a0a'
    }

    function readFrameTheme(value) {
      if (!value || typeof value !== 'object' || typeof value.dark !== 'boolean') return undefined
      const bg = sampleColor(value.background, 0.9)
      const fg = sampleColor(value.foreground, 0.5)
      const accent = sampleColor(value.accent, 0.85)
      const chromatic = Boolean(accent && Math.max(accent.r, accent.g, accent.b) - Math.min(accent.r, accent.g, accent.b) > 10)
      const accentFg = chromatic ? sampleColor(value.accentForeground, 0.85) : null
      return {
        dark: value.dark,
        background: bg ? bg.css : '',
        foreground: fg ? fg.css : '',
        accent: chromatic ? accent.css : '',
        accentForeground: accentFg ? accentFg.css : '',
      }
    }

    function colorWithAlpha(color, alpha) {
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
      if (hex) {
        const value = hex[1].length === 3 ? hex[1].split('').map(part => part + part).join('') : hex[1]
        const number = parseInt(value, 16)
        return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`
      }
      const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color)
      if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`
      const sampled = sampleColor(color, 0.05)
      if (sampled) return `rgba(${sampled.r}, ${sampled.g}, ${sampled.b}, ${alpha})`
      return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`
    }

    // 右侧 Agent 面板与弹出的菜单、选择器、代码块、对话卡片直接复用嵌入页底色与前景色，亮色暗色都与左侧一致且满足 >= 4.5:1 对比度。
    function frameThemeStyle(theme) {
      if (!theme) return undefined
      const fallbackBg = theme.dark ? { css: '#141414', r: 20, g: 20, b: 20, a: 1 } : { css: '#ffffff', r: 255, g: 255, b: 255, a: 1 }
      const bgSample = sampleColor(theme.background, 0.9) || fallbackBg
      const surfaceDark = relativeLuminance(bgSample) < 0.18
      const acceptForeground = candidate => {
        if (!candidate) return null
        const opaque = compositeOver(candidate, bgSample)
        const highestSurface = mixRgb(bgSample, opaque, surfaceDark ? 0.18 : 0.1)
        return contrastRatio(candidate, bgSample) >= 4.5 && contrastRatio(candidate, highestSurface) >= 4.5 ? candidate : null
      }
      const defaultFg = surfaceDark ? { css: 'rgba(255, 255, 255, 0.88)', r: 255, g: 255, b: 255, a: 0.88 } : { css: 'rgba(0, 0, 0, 0.88)', r: 0, g: 0, b: 0, a: 0.88 }
      const solidFg = surfaceDark ? { css: '#ffffff', r: 255, g: 255, b: 255, a: 1 } : { css: '#0a0a0a', r: 10, g: 10, b: 10, a: 1 }
      const fgSample = acceptForeground(sampleColor(theme.foreground, 0.5)) || acceptForeground(defaultFg) || solidFg
      const background = bgSample.css
      const foreground = fgSample.css
      const fgOpaque = compositeOver(fgSample, bgSample)
      const layer1Sample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.05 : 0.02)
      const layer2Sample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.08 : 0.04)
      const menuSample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.11 : 0.02)
      const bubbleSample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.09 : 0.05)
      const codeSample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.05 : 0.03)
      const inputMajorSample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.07 : 0)
      const textSurfaces = [bgSample, layer1Sample, layer2Sample, menuSample, bubbleSample, inputMajorSample]
      const readableAlpha = (minAlpha, surfaces = textSurfaces) => {
        for (let alpha = minAlpha; alpha <= 1.001; alpha += 0.02) {
          const clamped = Math.min(1, Number(alpha.toFixed(2)))
          if (surfaces.every(surface => contrastRatio({ r: fgSample.r, g: fgSample.g, b: fgSample.b, a: clamped }, surface) >= 4.5)) {
            return colorWithAlpha(foreground, clamped)
          }
        }
        return `rgb(${fgSample.r}, ${fgSample.g}, ${fgSample.b})`
      }
      const cardSurfaces = [layer1Sample, layer2Sample]
      const codeSurfaces = [codeSample]
      const accentSample = sampleColor(theme.accent, 0.85)
      const whiteSample = { r: 255, g: 255, b: 255, a: 1 }
      const inkSample = { r: 10, g: 10, b: 10, a: 1 }
      const defaultLink = pickReadableToken('#60a5fa', '#2563eb', surfaceDark, textSurfaces)
      const link = accentSample && textSurfaces.every(surface => contrastRatio(accentSample, surface) >= 4.5) ? accentSample.css : defaultLink
      const useAccentInfo = Boolean(accentSample && contrastRatio(whiteSample, accentSample) >= 4.5)
      const infoFill = useAccentInfo ? accentSample.css : '#2563eb'
      const infoHover = useAccentInfo ? mixColor(accentSample.css, '#000000', 12) : '#1d4ed8'
      const primarySample = accentSample ? compositeOver(accentSample, bgSample) : fgOpaque
      const primaryFill = accentSample ? accentSample.css : foreground
      const accentFgSample = accentSample ? sampleColor(theme.accentForeground, 0.85) : null
      const primaryForeground = accentFgSample && contrastRatio(accentFgSample, primarySample) >= 4.5 ? accentFgSample.css
        : !accentSample && contrastRatio(bgSample, primarySample) >= 4.5 ? background
          : contrastRatio(whiteSample, primarySample) >= contrastRatio(inkSample, primarySample) ? '#ffffff' : '#0a0a0a'
      const primaryFgSample = sampleColor(primaryForeground, 0.85) || whiteSample
      const primaryHoverTint = relativeLuminance(primaryFgSample) > 0.5
        ? (contrastRatio(primaryFgSample, mixRgb(primarySample, whiteSample, 0.12)) >= 4.5 ? '#ffffff' : '#000000')
        : (contrastRatio(primaryFgSample, mixRgb(primarySample, { r: 0, g: 0, b: 0, a: 1 }, 0.12)) >= 4.5 ? '#000000' : '#ffffff')
      const primaryHover = mixColor(primaryFill, primaryHoverTint, 12)
      const pick = (darkHex, lightHex, surfaces, tint = 0) => pickReadableToken(darkHex, lightHex, surfaceDark, surfaces, tint)
      const mixBg = (darkPct, lightPct) => mixColor(background, foreground, surfaceDark ? darkPct : lightPct)
      const fgAlpha = (darkAlpha, lightAlpha = darkAlpha) => colorWithAlpha(foreground, surfaceDark ? darkAlpha : lightAlpha)
      const layer1 = mixBg(5, 2)
      const layer2 = mixBg(8, 4)
      const layer3 = mixBg(12, 6)
      const layer4 = mixBg(16, 9)
      const menuBase = mixBg(11, 2)
      const codeBlock = mixBg(5, 3)
      const border1 = fgAlpha(0.08)
      const border2 = fgAlpha(0.14)
      const border3 = fgAlpha(0.2, 0.18)
      const border4 = fgAlpha(0.26, 0.24)
      const scrollbarThumb = fgAlpha(0.18)
      const scrollbarHover = fgAlpha(0.3)
      const errorPrimary = pick('#ffa8a8', '#991b1b', [...textSurfaces, mixRgb(codeSample, { r: 220, g: 38, b: 38, a: 1 }, surfaceDark ? 0.12 : 0.08)], 0.1)
      const successPrimary = pick('#69db7c', '#166534', [...textSurfaces, surfaceDark ? { r: 30, g: 53, b: 38, a: 1 } : { r: 230, g: 250, b: 237, a: 1 }, mixRgb(codeSample, { r: 34, g: 197, b: 94, a: 1 }, surfaceDark ? 0.12 : 0.08)], 0.1)
      const warnPrimary = pick('#fcc419', '#92400e', [...textSurfaces, surfaceDark ? { r: 39, g: 36, b: 31, a: 1 } : { r: 254, g: 245, b: 231, a: 1 }], 0.12)
      const stepFgOn = hex => { const f = sampleColor(hex, 0.9) || bgSample; return contrastRatio(whiteSample, f) >= contrastRatio(inkSample, f) ? '#ffffff' : '#0a0a0a' }
      const syntaxTokens = Object.fromEntries([
        ['--beeftv-json-property', '#5db0d7', '#881391', cardSurfaces],
        ['--beeftv-json-string', '#f28b82', '#b31412', cardSurfaces],
        ['--beeftv-json-number', '#99c8ff', '#1c00cf', cardSurfaces],
        ['--beeftv-json-keyword', '#99c8ff', '#1c00cf', cardSurfaces],
        ['--beeftv-json-punctuation', '#e8eaed', '#202124', cardSurfaces],
        ['--beeftv-json-icon', '#9aa0a6', '#54585d', cardSurfaces],
        ['--shiki-token-constant', '#4dabf7', '#1864ab', codeSurfaces],
        ['--shiki-token-string', '#69db7c', '#237032', codeSurfaces],
        ['--shiki-token-comment', '#adb5bd', '#5c646d', codeSurfaces],
        ['--shiki-token-keyword', '#faa2c1', '#c2255c', codeSurfaces],
        ['--shiki-token-parameter', '#ffa94d', '#c94408', codeSurfaces],
        ['--shiki-token-function', '#b197fc', '#5f3dc4', codeSurfaces],
        ['--shiki-token-string-expression', '#8ce99a', '#237032', codeSurfaces],
        ['--shiki-token-punctuation', '#ced4da', '#495057', codeSurfaces],
        ['--shiki-token-link', '#74c0fc', '#1864ab', codeSurfaces],
      ].map(([token, darkHex, lightHex, surfaces]) => [token, pick(darkHex, lightHex, surfaces)]))
      const dl = (darkVal, lightVal) => (surfaceDark ? darkVal : lightVal)
      const tipBg = dl('#353638', '#2c2c2e')
      return {
        colorScheme: dl('dark', 'light'), ...syntaxTokens,
        '--beeftv-step-done-fg': stepFgOn(successPrimary), '--beeftv-step-error-fg': stepFgOn(errorPrimary),
        '--beeftv-card-fill': layer1, '--beeftv-card-hover': layer2, '--beeftv-json-hover': fgAlpha(0.05, 0.04),
        '--beeftv-card-icon-bg': dl('rgba(255, 255, 255, 0.05)', 'rgba(255, 255, 255, 0.55)'),
        '--dsw-alias-bg-base': background, '--dsw-alias-bg-document-preview': dl(background, layer2),
        '--dsw-alias-bg-layer-1': layer1, '--dsw-alias-bg-layer-2': layer2, '--dsw-alias-bg-layer-3': layer3, '--dsw-alias-bg-layer-4': layer4,
        '--dsw-alias-bg-overlay': mixBg(14, 6), '--dsw-alias-bg-module-platform': mixBg(10, 4), '--dsw-alias-bg-multi-select': mixBg(8, 4),
        '--dsw-alias-bg-skeleton': fgAlpha(0.08, 0.05), '--dsw-alias-bg-mask-drop': colorWithAlpha(layer2, 0.72),
        '--dsw-alias-bg-mask-1': dl('rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0.24)'), '--dsw-alias-bg-mask-2': dl('rgba(0, 0, 0, 0.2)', 'rgba(0, 0, 0, 0.12)'),
        '--dsw-alias-settings-card-fill': layer2, '--dsw-alias-settings-card-stroke': border4,
        '--dsw-menu-surface-fill': `color-mix(in srgb, ${menuBase} 94%, transparent)`,
        '--dsw-specific-menu': `color-mix(in srgb, ${menuBase} 96%, transparent)`,
        '--dsw-alias-menu-group-header-fill': `color-mix(in srgb, ${menuBase} 96%, transparent)`,
        '--dsw-alias-menu-icon': readableAlpha(dl(0.82, 0.78)),
        '--dsw-specific-selector': mixBg(13, 6), '--dsw-specific-tip': mixBg(11, 4),
        '--dsw-specific-input-major': mixBg(7, 0), '--dsw-specific-login-input': layer1,
        '--dsw-specific-bubble': mixBg(9, 5), '--dsw-specific-bubble-highlight': mixBg(15, 10),
        '--dsw-alias-interactive-bg-hover': fgAlpha(0.08, 0.06), '--dsw-alias-interactive-bg-active': fgAlpha(0.14, 0.1),
        '--dsw-alias-interactive-bg-hover-accent': fgAlpha(0.2, 0.14), '--dsw-alias-interactive-bg-hover-solid': mixBg(18, 10),
        '--dsw-alias-interactive-bg-hover-danger': dl('rgba(242, 90, 90, 0.15)', 'rgba(200, 30, 30, 0.08)'),
        '--dsw-alias-label-primary': foreground, '--dsw-alias-label-primary-dimmed': readableAlpha(0.88),
        '--dsw-alias-label-primary-bluish': foreground, '--dsw-alias-label-primary-foreground': primaryForeground,
        '--dsw-alias-label-primary-inverted': dl(layer3, background),
        '--dsw-alias-label-secondary': readableAlpha(0.72), '--dsw-alias-label-document-preview': readableAlpha(0.72),
        '--dsw-alias-label-tertiary': readableAlpha(dl(0.58, 0.6)),
        '--dsw-alias-label-caption': readableAlpha(dl(0.52, 0.56), [bgSample, inputMajorSample]),
        '--dsw-alias-label-dimmed': fgAlpha(0.34, 0.32), '--dsw-alias-label-shimmer': fgAlpha(0.45, 0.3),
        '--dsw-alias-border-l1': border1, '--dsw-alias-border-l2': border2, '--dsw-alias-border-l2-darkmode-thin': dl(border1, border2),
        '--dsw-alias-border-l3': border3, '--dsw-alias-border-l4': border4, '--dsw-elevation-stroke-color': dl(border3, border4),
        '--dsw-alias-border-inverted': dl(border1, 'transparent'), '--dsw-alias-border-inverted2': dl(border2, 'transparent'),
        '--dsw-alias-scrollbar-bg-l1': scrollbarThumb, '--dsw-alias-scrollbar-bg-l2': fgAlpha(0.22),
        '--dsw-alias-scrollbar-hover-l1': scrollbarHover, '--dsw-alias-scrollbar-hover-l2': fgAlpha(0.36),
        '--dsh-scrollbar-thumb': scrollbarThumb, '--dsh-scrollbar-thumb-hover': scrollbarHover,
        '--dsw-alias-link': link, '--dsw-alias-state-business-primary': link, '--dsw-alias-state-business-tertiary': colorWithAlpha(link, 0.16),
        '--dsw-alias-brand-primary': primaryFill, '--dsw-alias-brand-primary-invert': primaryFill, '--dsw-alias-brand-text': foreground,
        '--dsw-alias-button-primary-fill': primaryFill, '--dsw-alias-button-primary-hover': primaryHover, '--dsw-alias-button-primary-dimmed': layer2,
        '--dsw-alias-button-info-fill': infoFill, '--dsw-alias-button-info-hover': infoHover,
        '--dsw-alias-button-contrast-fill': dl(foreground, fgAlpha(0.72)), '--dsw-alias-button-elevated-fill': dl(layer3, background),
        '--dsw-alias-button-floating-fill': dl(layer2, background), '--dsw-alias-button-floating-hover': dl(layer3, layer2),
        '--dsw-alias-button-ghost-active-border': border4, '--dsw-alias-button-ghost-active-fill': layer2, '--dsw-alias-button-ghost-active-hover': layer3,
        '--dsw-alias-switch-thumb': dl(mixColor(background, foreground, 72), '#ffffff'),
        '--dsw-alias-tooltip-bg': tipBg, '--dsw-alias-toast-bg': tipBg, '--dsw-alias-toast-label': '#f9fafb',
        '--dsw-alias-state-done-primary': pick('#b197fc', '#6d28d9', textSurfaces), '--dsw-alias-state-error-primary': errorPrimary,
        '--dsw-alias-state-idle-primary': fgAlpha(0.3), '--dsw-alias-state-success-primary': successPrimary,
        '--dsw-alias-state-success-tertiary': dl('#1e3526', '#e6faed'),
        '--dsw-alias-state-warn-primary': warnPrimary, '--dsw-alias-state-warn-label': warnPrimary,
        '--dsw-alias-state-warn-tertiary': dl('#27241f', '#fef5e7'),
        '--dsw-alias-markdown-code-block': codeBlock, '--dsw-alias-markdown-code-block-banner': mixBg(8, 5),
        '--dsw-alias-markdown-code-segment-selected': dl(layer3, background), '--dsw-alias-markdown-code-segment-unselected': dl(codeBlock, layer2),
        '--dsw-alias-markdown-inline-code': mixBg(9, 5), '--dsw-alias-markdown-citation': mixBg(11, 6), '--dsw-alias-markdown-tag': mixBg(9, 5),
        '--dsw-alias-markdown-placeholder': layer2,
        '--dsw-alias-turn-trigger-bg': dl(fgAlpha(0.08), codeBlock), '--dsw-alias-turn-trigger-bg-hover': fgAlpha(0.14, 0.08),
        '--dsw-linear-gradient-think': `linear-gradient(180deg, ${background} 20.19%, transparent 100%)`,
        '--dsw-linear-think-select': `linear-gradient(180deg, ${layer1} 20.19%, transparent 100%)`,
        '--dsw-alias-code-diff-added': dl('#22c55e1f', '#22c55e14'), '--dsw-alias-code-diff-deleted': dl('#f25a5a1f', '#b91c1c14'),
        '--dsw-alias-file-diff-added-bg': dl('#1f3124', '#e6f4e7'), '--dsw-alias-file-diff-added-gutter': dl('#132016', '#edf7ed'), '--dsw-alias-file-diff-added-marker': dl('#41c977', '#01a241'),
        '--dsw-alias-file-diff-deleted-bg': dl('#3c1f1b', '#fce6e2'), '--dsw-alias-file-diff-deleted-gutter': dl('#28130e', '#fdece9'), '--dsw-alias-file-diff-deleted-marker': dl('#fa423e', '#ba2723'),
        '--shiki-foreground': foreground, '--shiki-background': codeBlock,
      }
    }

    // 网页「问助手」交接：入口固定为 selection-toolbar，节点最多 20 个、标题最多 80 字。
    function readAsk(value) {
      if (!value || typeof value !== 'object' || value.source !== 'selection-toolbar' || typeof value.canvasId !== 'string') return undefined
      return {
        source: 'selection-toolbar',
        canvasId: value.canvasId.slice(0, 256),
        canvasTitle: typeof value.canvasTitle === 'string' ? value.canvasTitle.slice(0, 256) : '',
        nodes: Array.isArray(value.nodes)
          ? value.nodes.filter(node => node && typeof node.id === 'string' && node.id).slice(0, 20).map(node => ({
              id: node.id.slice(0, 256),
              title: typeof node.title === 'string' ? node.title.slice(0, 80) : '',
              type: typeof node.type === 'string' ? node.type.slice(0, 40) : '',
            }))
          : [],
      }
    }

    function askPrompt(ask) {
      const canvasName = ask.canvasTitle || '当前画布'
      const titles = ask.nodes.map(node => node.title || '未命名节点')
      if (!titles.length) return `画布「${canvasName}」中选中的节点\n`
      const listed = titles.length > 5 ? `${titles.slice(0, 5).join('、')} 等 ${titles.length} 个节点` : titles.join('、')
      return `画布「${canvasName}」中选中的：${listed}\n`
    }

    function FixedChatView({ renderSlot }) {
      return renderSlot('conversation.session', { view: 'chat' })
    }

    function NativeConversation({ sessionId, useSession, renderFactorySlot, connectionId, workspaceContext, agentMode, onError, onStaleConnection, onAgentActivity }) {
      const session = useSession(value => value)
      const settling = session === undefined || session.openState === 'loading'
      const running = Boolean(session?.running)
      // 渲染期同步记住，避免切换会话后消息落在 passive effect 之前。
      conversationSessionId = sessionId

      React.useEffect(() => () => {
        if (conversationSessionId === sessionId) conversationSessionId = undefined
      }, [sessionId])

      React.useEffect(() => {
        if (!running || !onAgentActivity) return
        onAgentActivity()
        const timer = window.setInterval(onAgentActivity, 1200)
        return () => {
          window.clearInterval(timer)
          onAgentActivity()
        }
      }, [running, onAgentActivity])

      React.useEffect(() => {
        if (sessionId === undefined || !connectionId) return
        const controller = new AbortController()
        api('context', { context: workspaceContext || { route: '/', selectedNodeIds: [] }, connectionId, sessionId, agentMode }, controller.signal).catch(error => {
          if (controller.signal.aborted) return
          if (error.status === 409) onStaleConnection()
          else onError(error.message)
        })
        return () => controller.abort()
      }, [sessionId, connectionId, workspaceContext, agentMode, onError, onStaleConnection])

      if (sessionId === undefined) {
        return h('div', { className: 'beeftv-harness-onboarding' },
          h('p', null, '点击“新建会话”开始与 BeefTV Agent 协作。'))
      }

      return renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: settling ? 'settling' : 'active',
        hero: false,
      }, { slots: { views: FixedChatView } })
    }

    const activeProvisionPhases = new Set(['checking', 'downloading', 'verifying', 'extracting'])

    function formatMB(bytes) {
      return `${(Math.max(0, Number(bytes) || 0) / 1_048_576).toFixed(1)} MB`
    }

    function provisionSummary(provision) {
      if (!provision || !activeProvisionPhases.has(provision.phase)) return ''
      const versionTag = provision.version ? ` ${provision.version}` : ''
      if (provision.phase === 'checking') return '正在检查 BeefTV 运行环境…'
      if (provision.phase === 'downloading') {
        const progress = provision.totalBytes > 0
          ? `（${provision.percent ?? 0}% · ${formatMB(provision.downloadedBytes)} / ${formatMB(provision.totalBytes)}）`
          : (provision.downloadedBytes > 0 ? `（已下载 ${formatMB(provision.downloadedBytes)}）` : '')
        const sourceTag = provision.sourceLabel ? ` · ${provision.sourceLabel}` : ''
        return `正在下载 BeefTV${versionTag}${progress}${sourceTag}…`
      }
      if (provision.phase === 'verifying') return `正在校验 BeefTV${versionTag} 安装包…`
      return `正在解压 BeefTV${versionTag} 运行环境…`
    }

    function ProvisionProgress({ provision, onCancel }) {
      const text = provisionSummary(provision)
      if (!text) return null
      const width = provision.phase === 'downloading' && typeof provision.percent === 'number'
        ? `${Math.max(2, Math.min(100, provision.percent))}%`
        : '100%'
      return h('div', { className: 'beeftv-harness-progress', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'beeftv-harness-progress-row' },
          h('span', null, text),
          onCancel && h('button', { type: 'button', onClick: onCancel }, '取消')),
        h('div', { className: 'beeftv-harness-progress-bar' },
          h('div', { className: 'beeftv-harness-progress-fill', style: { width } })))
    }

    function Onboarding({ busy, connect, loading, localApp, standaloneRuntime, provision, onCancelProvision }) {
      const provisioning = activeProvisionPhases.has(provision?.phase)
      const standaloneUnsupported = standaloneRuntime?.supported === false
      const standaloneHint = standaloneUnsupported
        ? standaloneRuntime.unsupportedReason
        : standaloneRuntime?.ready === false
          ? '首次使用会在插件内自动下载官方运行环境，无需单独安装 BeefTV 客户端。'
          : '在 DSH 内直接运行 BeefTV 独立工作区，无需额外安装客户端。'
      const localOption = h('button', { key: 'local', type: 'button', className: 'beeftv-harness-option', disabled: busy || loading, onClick: () => connect('local') },
        h('strong', null, busy === 'local' ? '正在连接…' : '连接本机 BeefTV'),
        h('span', null, localApp?.message || '与本机已安装的 BeefTV 互通，共享同一套画布、素材、配置与版本更新。'))
      const standaloneOption = h('button', { key: 'standalone', type: 'button', className: 'beeftv-harness-option', disabled: busy || loading || standaloneUnsupported, onClick: () => connect('standalone') },
        h('strong', null, busy === 'standalone' ? (provisioning ? '正在准备运行环境…' : '正在创建连接…') : '使用独立工作区'),
        h('span', null, standaloneHint))
      const preferStandaloneFirst = localApp?.compatible === false && !localApp?.version && !standaloneUnsupported
      const options = preferStandaloneFirst ? [standaloneOption, localOption] : [localOption, standaloneOption]
      return h('div', { className: 'beeftv-harness-onboarding' },
        h('div', { className: 'beeftv-harness-onboarding-content' },
          h('h1', null, '在 DSH 中打开 BeefTV'),
          h('p', null, loading ? '正在读取本机连接状态…' : '选择工作区，BeefTV Agent 会持续协助当前创作。'),
          h('div', { className: 'beeftv-harness-options' }, options),
          h(ProvisionProgress, { provision, onCancel: onCancelProvision })))
    }

    function Workbench({ renderSlot, returnToConversation, createCreativeSession, askAssistant }) {
      const [status, setStatus] = React.useState()
      const [busy, setBusy] = React.useState(false)
      const [liveProvision, setLiveProvision] = React.useState(null)
      const [updatingRuntime, setUpdatingRuntime] = React.useState(false)
      const [checkingUpdate, setCheckingUpdate] = React.useState(false)
      const [updateBanner, setUpdateBanner] = React.useState('')
      const [updateDismissedVersion, setUpdateDismissedVersion] = React.useState('')
      const [error, setError] = React.useState('')
      const [statusError, setStatusError] = React.useState('')
      const [choosingWorkspace, setChoosingWorkspace] = React.useState(false)
      const [reportedContext, setReportedContext] = React.useState()
      const [agentMode, setAgentMode] = React.useState('creation')
      const [frameTheme, setFrameTheme] = React.useState()
      const [creatingSession, setCreatingSession] = React.useState(false)
      const [agentWidth, setAgentWidth] = React.useState(432)
      const [availableWidth, setAvailableWidth] = React.useState(718)
      const [resizing, setResizing] = React.useState(false)
      const [actionsOpen, setActionsOpen] = React.useState(false)
      const root = React.useRef(null)
      const body = React.useRef(null)
      const drag = React.useRef(null)
      const frame = React.useRef(null)
      const clearanceProbe = React.useRef(null)
      const connecting = React.useRef(false)
      const autoConnectAttempted = React.useRef(false)
      const lastActivity = React.useRef({ connectionId: undefined, seq: 0 })
      const statusRequest = React.useRef(null)
      const refreshStatus = React.useRef(null)
      const requestStatusRefresh = React.useCallback(() => refreshStatus.current?.(), [])
      const skipStepSave = React.useRef(false)
      const statusGeneration = React.useRef(0)
      const actionsButton = React.useRef(null)
      const reportError = React.useCallback(message => setError(message), [])
      const appURL = !choosingWorkspace && status?.connected ? status.appURL : undefined
      const source = React.useMemo(() => frameURL(appURL), [appURL])
      const publishFrameClearance = React.useCallback(() => {
        if (!source || !frame.current?.contentWindow || !clearanceProbe.current) return
        frame.current.contentWindow.postMessage({ type: 'beeftv:host-chrome', leading: clearanceProbe.current.getBoundingClientRect().width }, new URL(source).origin)
      }, [source])
      const connectionId = status?.connectionId
      const workspaceContext = reportedContext?.connectionId === connectionId ? reportedContext?.context : undefined
      const autoContinue = status?.autoContinue !== false

      const clampAgentWidth = width => Math.max(320, Math.min(width, Math.max(320, (body.current?.clientWidth || 718) - 286)))

      React.useEffect(() => {
        const observer = new ResizeObserver(() => {
          setAvailableWidth(body.current.clientWidth)
          setAgentWidth(width => clampAgentWidth(width))
        })
        observer.observe(body.current)
        return () => observer.disconnect()
      }, [])

      React.useEffect(() => {
        const observer = new ResizeObserver(publishFrameClearance)
        observer.observe(clearanceProbe.current)
        publishFrameClearance()
        return () => observer.disconnect()
      }, [publishFrameClearance])

      function startResize(event) {
        if (event.button !== 0 || drag.current) return
        event.preventDefault()
        drag.current = { pointerId: event.pointerId, x: event.clientX, width: agentWidth }
        event.currentTarget.setPointerCapture(event.pointerId)
        setResizing(true)
      }
      const moveResize = event => {
        const start = drag.current
        if (start?.pointerId === event.pointerId) setAgentWidth(clampAgentWidth(start.width + start.x - event.clientX))
      }
      const endResize = () => { drag.current = null; setResizing(false) }
      const resizeWithKeyboard = event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        setAgentWidth(width => clampAgentWidth(width + (event.key === 'ArrowLeft' ? 16 : -16)))
      }

      React.useEffect(() => {
        let mounted = true
        let initialRead = true
        async function refresh() {
          if (connecting.current || statusRequest.current || (!initialRead && document.hidden)) return
          initialRead = false
          const controller = new AbortController()
          const timeout = new AbortController()
          const timer = window.setTimeout(() => timeout.abort(), 10_000)
          const generation = statusGeneration.current
          statusRequest.current = controller
          try {
            const next = await api('status', undefined, AbortSignal.any([controller.signal, timeout.signal]))
            if (!mounted || controller.signal.aborted || connecting.current || generation !== statusGeneration.current) return
            setStatus(current => ['connected', 'mode', 'appURL', 'version', 'error', 'connectionId', 'localPromptDismissed', 'autoContinue', 'stepLimit', 'awayNotice', 'stepNotice', 'updatingRuntime'].every(key => current?.[key] === next[key])
              && current?.workspace?.id === next.workspace?.id && current?.build?.commit === next.build?.commit
              && current?.activity?.seq === next.activity?.seq
              && current?.localApp?.message === next.localApp?.message && current?.localApp?.compatible === next.localApp?.compatible
              && current?.standaloneRuntime?.ready === next.standaloneRuntime?.ready && current?.standaloneRuntime?.source === next.standaloneRuntime?.source
              && current?.standaloneRuntime?.version === next.standaloneRuntime?.version
              && current?.standaloneRuntime?.updateAvailable?.version === next.standaloneRuntime?.updateAvailable?.version
              && current?.provision?.phase === next.provision?.phase && current?.provision?.percent === next.provision?.percent
              ? current : next)
            setStatusError('')
          } catch (failure) {
            if (!mounted || controller.signal.aborted) return
            setStatusError(timeout.signal.aborted ? '读取工作区连接超时，请重试' : failure.message)
            setStatus(current => current || { connected: false })
          } finally {
            window.clearTimeout(timer)
            if (statusRequest.current === controller) statusRequest.current = null
          }
        }
        refreshStatus.current = refresh
        refresh()
        const timer = window.setInterval(refresh, 5000)
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
          mounted = false
          window.clearInterval(timer)
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', refresh)
          statusRequest.current?.abort()
          statusRequest.current = null
          refreshStatus.current = null
        }
      }, [])

      const latestRoute = React.useRef('/')
      latestRoute.current = workspaceContext?.route || '/'
      React.useEffect(() => { setFrameTheme(undefined) }, [source])
      React.useEffect(() => {
        setReportedContext(undefined)
        if (!source) return
        const origin = new URL(source).origin
        const onFrameMessage = async event => {
          if (event.source !== frame.current?.contentWindow || event.origin !== origin) return
          const type = event.data?.type
          if (type === 'beeftv:context') {
            const context = readWorkspaceContext(event.data.context)
            if (context && connectionId) setReportedContext({ connectionId, context })
          } else if (type === 'beeftv:theme') {
            const theme = readFrameTheme(event.data)
            if (!theme) return
            setFrameTheme(current => current && ['dark', 'background', 'foreground', 'accent', 'accentForeground'].every(key => current[key] === theme[key]) ? current : theme)
          } else if (type === 'beeftv:ask') {
            const ask = readAsk(event.data.ask)
            if (!ask || !connectionId) return
            // 模型后续看到的是这次选中的节点，不依赖提示词里的标题。
            setReportedContext({ connectionId, context: { route: latestRoute.current, canvasId: ask.canvasId, canvasTitle: ask.canvasTitle, selectedNodeIds: ask.nodes.map(node => node.id) } })
            const askStatus = await askAssistant(ask)
            frame.current?.contentWindow?.postMessage({ type: 'beeftv:ask-result', status: askStatus }, origin)
          }
        }
        window.addEventListener('message', onFrameMessage)
        return () => window.removeEventListener('message', onFrameMessage)
      }, [source, connectionId, askAssistant])

      React.useEffect(() => {
        if (!connectionId) {
          lastActivity.current = { connectionId: undefined, seq: 0 }
          return
        }
        const nextSeq = status?.activity?.seq || 0
        if (lastActivity.current.connectionId !== connectionId) {
          lastActivity.current = { connectionId, seq: nextSeq }
          return
        }
        if (nextSeq <= lastActivity.current.seq) return
        lastActivity.current = { connectionId, seq: nextSeq }
        if (!source || !frame.current?.contentWindow) return
        frame.current.contentWindow.postMessage({ type: 'beeftv:workspace-sync', activity: status.activity }, new URL(source).origin)
      }, [connectionId, source, status?.activity])

      React.useEffect(() => {
        if (autoConnectAttempted.current || choosingWorkspace || busy || connecting.current) return
        if (status?.connected !== false || status.mode !== null || status.switching || status.error || statusError) return
        // 本机已装兼容版 BeefTV 时自动互通；本机未装但插件已有独立运行环境时直接进入独立工作区。
        if (status.localApp?.compatible === true) {
          autoConnectAttempted.current = true
          void connect('local')
        } else if (status.localApp?.compatible === false && !status.localApp?.version && status.standaloneRuntime?.ready === true) {
          autoConnectAttempted.current = true
          void connect('standalone')
        }
      }, [status, choosingWorkspace, busy, statusError])

      function startProvisionPolling() {
        let stopped = false
        const poll = async () => {
          if (stopped) return
          try {
            const snap = await api('status')
            if (!stopped && snap?.provision) setLiveProvision(snap.provision)
          } catch { /* 下一次继续读取进度 */ }
        }
        const timer = window.setInterval(poll, 500)
        return () => {
          stopped = true
          window.clearInterval(timer)
          setLiveProvision(null)
        }
      }

      // 写入/连接/更新前作废在途的状态轮询，避免旧连接状态把刚生效的结果翻回去。
      async function withStatusMutation(action, { blockPolling = false } = {}) {
        statusGeneration.current += 1
        statusRequest.current?.abort()
        statusRequest.current = null
        if (blockPolling) connecting.current = true
        try { return await action() } finally {
          if (blockPolling) connecting.current = false
          statusGeneration.current += 1
        }
      }

      async function connect(mode) {
        setBusy(mode)
        setError('')
        const stopPolling = mode === 'standalone' && status?.standaloneRuntime?.ready === false ? startProvisionPolling() : null
        try {
          await withStatusMutation(async () => {
            setStatus(await api('connect', { mode }))
            setChoosingWorkspace(false)
            setStatusError('')
          }, { blockPolling: true })
        } catch (failure) {
          if (failure?.code !== 'BEEFTV_PROVISION_CANCELLED') setError(failure.message)
        } finally {
          stopPolling?.()
          setBusy(false)
        }
      }

      async function cancelProvision() {
        try { setLiveProvision((await api('runtime/cancel', {}))?.provision || null) } catch { /* 忽略取消时的临时失败 */ }
      }

      async function runMenuAction(setFlag, action, { ignoreCancel = false } = {}) {
        setActionsOpen(false)
        setFlag(true)
        setError('')
        try { await action() } catch (failure) {
          if (!ignoreCancel || failure?.code !== 'BEEFTV_PROVISION_CANCELLED') setError(failure.message)
        } finally { setFlag(false) }
      }

      const checkRuntimeUpdate = () => runMenuAction(setCheckingUpdate, () => withStatusMutation(async () => {
        setUpdateBanner('')
        const next = await api('runtime/check-update', {})
        setStatus(next)
        if (next?.standaloneRuntime?.updateAvailable?.version) setUpdateDismissedVersion('')
        else setUpdateBanner('当前 BeefTV 运行环境已是最新版本。')
      }))

      const updateRuntime = () => runMenuAction(setUpdatingRuntime, () => withStatusMutation(async () => {
        setUpdateBanner('')
        const stopPolling = startProvisionPolling()
        try {
          setStatus(await api('runtime/update', {}))
          setUpdateDismissedVersion('')
          setStatusError('')
        } finally { stopPolling() }
      }, { blockPolling: true }), { ignoreCancel: true })

      const startCreativeSession = () => runMenuAction(setCreatingSession, createCreativeSession)
      const mutateStatus = (path, body) => (setError(''), withStatusMutation(() => api(path, body).then(setStatus, failure => setError(failure.message))))

      const saveSettings = patch => mutateStatus('settings', patch)
      const dismissNotice = path => mutateStatus(path, { seen: true })
      const dismissLocalPrompt = () => mutateStatus('local-prompt', { dismissed: true })

      const visibleError = error || status?.error || statusError
      const standalone = status?.connected === true && status?.mode === 'standalone' && !choosingWorkspace
      const localReady = standalone && status?.localApp?.compatible === true && !status?.localPromptDismissed
      const activeProvision = liveProvision || status?.provision || null
      const updateAvailable = standalone && status?.standaloneRuntime?.source === 'managed' ? status?.standaloneRuntime?.updateAvailable : null
      const showUpdateNotice = Boolean(updateAvailable?.version && updateDismissedVersion !== updateAvailable.version && !updatingRuntime)
      const themeStyle = React.useMemo(() => frameThemeStyle(frameTheme), [frameTheme])
      const portalStyleRef = React.useRef(null)
      const portalOriginRef = React.useRef(false)
      const hasThemeRef = React.useRef(false)

      // 模型/权限下拉、菜单背板、气泡提示、对话框与轻提示挂在 document.body 上：监听与样式节点随工作台挂载常驻，主题切换时原地更新规则，不打断已打开的浮层，也不改动宿主左侧栏。
      React.useEffect(() => {
        const portalChildren = `:is(${portalItems})`
        const portalOverlay = `body > ${portalChildren}`
        const styleElement = document.createElement('style')
        styleElement.dataset.beeftvPortalTheme = 'dsh-beeftv'
        styleElement.textContent = `body[data-beeftv-portal-theme] > ${portalChildren} {}`
        document.head.appendChild(styleElement)
        portalStyleRef.current = styleElement
        const events = ['pointerdown', 'pointerover', 'focusin', 'keydown', 'click', 'contextmenu']
        const syncPortalOrigin = event => {
          const target = event.target instanceof Element ? event.target : null
          if (!target) return
          if (root.current?.contains(target)) {
            portalOriginRef.current = true
            if (hasThemeRef.current) document.body.dataset.beeftvPortalTheme = '1'
          } else if (!target.closest(portalOverlay)) {
            portalOriginRef.current = false
            delete document.body.dataset.beeftvPortalTheme
          }
        }
        for (const type of events) document.addEventListener(type, syncPortalOrigin, true)
        if (document.activeElement instanceof Element && root.current?.contains(document.activeElement)) {
          portalOriginRef.current = true
        }
        return () => {
          for (const type of events) document.removeEventListener(type, syncPortalOrigin, true)
          portalOriginRef.current = false
          delete document.body.dataset.beeftvPortalTheme
          styleElement.remove()
          portalStyleRef.current = null
        }
      }, [])

      React.useEffect(() => {
        hasThemeRef.current = Boolean(themeStyle)
        const rule = portalStyleRef.current?.sheet?.cssRules?.[0]
        if (rule) {
          while (rule.style.length) rule.style.removeProperty(rule.style[0])
          if (themeStyle) {
            for (const [key, value] of Object.entries(themeStyle)) {
              rule.style.setProperty(key === 'colorScheme' ? 'color-scheme' : key, value)
            }
          }
        }
        if (!themeStyle) {
          delete document.body.dataset.beeftvPortalTheme
          return
        }
        if (portalOriginRef.current || (document.activeElement instanceof Element && root.current?.contains(document.activeElement))) {
          portalOriginRef.current = true
          document.body.dataset.beeftvPortalTheme = '1'
        }
      }, [themeStyle])

      const noticeBar = (text, ...buttons) => h('div', { className: 'beeftv-harness-notice', role: 'status' }, h('span', null, text), ...buttons)
      const btn = (label, onClick, extra = {}) => h('button', { type: 'button', onClick, ...extra }, label)

      return h('section', { ref: root, className: 'beeftv-harness', 'aria-label': 'BeefTV 工作台', 'data-resizing': resizing, 'data-beeftv-themed': themeStyle ? '' : undefined, style: themeStyle },
        h('span', { ref: clearanceProbe, className: 'beeftv-harness-clearance', 'aria-hidden': true }),
        visibleError && h('div', { className: 'beeftv-harness-error', role: 'alert' }, visibleError),
        standalone && h('div', { className: 'beeftv-harness-workspace-note' }, '独立工作区，和本机 BeefTV 不是同一份数据'),
        status?.awayNotice && noticeBar(status.awayNotice, btn('知道了', () => dismissNotice('away-notice'), { 'aria-label': '关闭离开提示' })),
        status?.stepNotice && noticeBar(status.stepNotice, btn('知道了', () => dismissNotice('step-notice'), { 'aria-label': '关闭步数提示' })),
        localReady && noticeBar('本机 BeefTV 可以连接了，连接后用同一份画布和素材。',
          btn('连接本机', () => connect('local'), { disabled: !!busy || updatingRuntime }),
          btn('暂不', dismissLocalPrompt, { disabled: !!busy || updatingRuntime })),
        showUpdateNotice && noticeBar(`BeefTV 运行环境有新版本（${updateAvailable.version}），更新完成后工作区会自动重启，画布和素材会完整保留。`,
          btn('立即更新', updateRuntime, { disabled: !!busy || updatingRuntime }),
          btn('暂不', () => setUpdateDismissedVersion(updateAvailable.version), { disabled: !!busy || updatingRuntime })),
        updatingRuntime && activeProvisionPhases.has(activeProvision?.phase) && noticeBar(provisionSummary(activeProvision), btn('取消', cancelProvision)),
        updateBanner && noticeBar(updateBanner, btn('知道了', () => setUpdateBanner(''))),
        h('div', { ref: body, className: 'beeftv-harness-body', style: { '--beeftv-agent-width': `${agentWidth}px` } },
          h('div', { className: 'beeftv-harness-workspace' }, source
            ? h('iframe', { key: source, ref: frame, src: source, onLoad: publishFrameClearance, title: 'BeefTV 创作工作区', className: 'beeftv-harness-frame', referrerPolicy: 'no-referrer', allow: 'clipboard-read; clipboard-write' })
            : h(Onboarding, { busy, connect, loading: status === undefined, localApp: status?.localApp, standaloneRuntime: status?.standaloneRuntime, provision: activeProvision, onCancelProvision: cancelProvision })),
          h('div', { className: 'beeftv-harness-divider', role: 'separator', tabIndex: 0, 'aria-label': '调整 BeefTV Agent 宽度', 'aria-orientation': 'vertical', 'aria-valuemin': 320, 'aria-valuemax': Math.max(320, availableWidth - 286), 'aria-valuenow': agentWidth, 'aria-controls': 'beeftv-agent-panel', onPointerDown: startResize, onPointerMove: moveResize, onPointerUp: endResize, onPointerCancel: endResize, onLostPointerCapture: endResize, onKeyDown: resizeWithKeyboard }),
          h('aside', { id: 'beeftv-agent-panel', className: 'beeftv-harness-agent', 'aria-label': 'BeefTV Agent', style: themeStyle },
            h('div', { className: 'beeftv-harness-agent-header' },
              h('div', { className: 'beeftv-harness-agent-title-row' },
                h('h2', { className: 'beeftv-harness-agent-heading' }, 'BeefTV Agent'),
                h('div', { className: 'beeftv-harness-actions', onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setActionsOpen(false) }, onKeyDown: event => { if (event.key === 'Escape') { setActionsOpen(false); actionsButton.current?.focus() } } },
                  h('button', { ref: actionsButton, type: 'button', 'aria-label': '工作台操作', 'aria-expanded': actionsOpen, onClick: () => { skipStepSave.current = false; setActionsOpen(open => !open) } }, '⋯'),
                  actionsOpen && h('div', { className: 'beeftv-harness-action-menu' },
                    h('button', { type: 'button', disabled: creatingSession, onClick: startCreativeSession }, creatingSession ? '正在创建…' : '新建会话'),
                    status?.connected && !choosingWorkspace && h('button', { type: 'button', disabled: !!busy || updatingRuntime, onClick: () => { setActionsOpen(false); setChoosingWorkspace(true) } }, '切换工作区'),
                    standalone && status?.standaloneRuntime?.source === 'managed' && (updateAvailable?.version
                      ? h('button', { type: 'button', disabled: !!busy || updatingRuntime, onClick: updateRuntime }, updatingRuntime ? '正在更新运行环境…' : `更新运行环境（${updateAvailable.version}）`)
                      : h('button', { type: 'button', disabled: checkingUpdate || updatingRuntime, onClick: checkRuntimeUpdate }, checkingUpdate ? '正在检查更新…' : '检查运行环境更新')),
                    h('button', { type: 'button', onClick: returnToConversation }, '返回 DSH'),
                    h('button', { type: 'button', 'aria-pressed': autoContinue, onClick: () => saveSettings({ autoContinue: !autoContinue }) }, '生成完自动继续'),
                    h('label', { className: 'beeftv-harness-setting' }, '每轮工具调用上限（0 不限）',
                      h('input', {
                        type: 'number', min: 0, max: 1000, step: 1, defaultValue: status?.stepLimit ?? 0,
                        onBlur: event => {
                          if (skipStepSave.current) { skipStepSave.current = false; return }
                          saveSettings({ stepLimit: Number(event.currentTarget.value) })
                        },
                        onKeyDown: event => {
                          if (event.key === 'Escape') skipStepSave.current = true
                          if (event.key === 'Enter') event.currentTarget.blur()
                        },
                      }))))),
              h('div', { className: 'beeftv-harness-modes', 'aria-label': '协作方向' }, modes.map(mode =>
                h('button', { key: mode.id, type: 'button', title: mode.detail, 'aria-pressed': agentMode === mode.id, onClick: () => setAgentMode(mode.id) }, mode.label))),
              workspaceContext?.canvasTitle && h('div', { className: 'beeftv-harness-context', title: workspaceContext.canvasTitle }, workspaceContext.canvasTitle)),
            h('div', { className: 'beeftv-harness-conversation' }, renderSlot(conversationSlot, { connectionId, workspaceContext, agentMode, onError: reportError, onStaleConnection: requestStatusRefresh, onAgentActivity: requestStatusRefresh })))))
    }

    function Icon({ size = 18 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 4, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'm10 8 6 4-6 4Z', fill: 'currentColor' }))
    }

    function askAssistant(ctx) {
      const prefill = (input, binding, prompt) => {
        const result = input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' })
        return ['applied', 'preserved', 'blocked'].includes(result) ? result : 'unavailable'
      }
      return async ask => {
        const prompt = askPrompt(ask)
        const input = ctx.get?.('conversation')?.input
        try {
          if (typeof input?.requestDraftInitialization !== 'function') {
            // 旧版 DSH 没有输入框预填接口：退回新建会话，由 startSession 自己放草稿。
            if (typeof ctx.uiWorkspace?.startSession !== 'function') return 'unavailable'
            ctx.uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
            ctx.layout.selectPanel(panelId)
            return 'applied'
          }
          let binding
          try {
            binding = conversationSessionId === undefined ? undefined : ctx.sessions?.binding?.(conversationSessionId)
          } catch {
            binding = undefined
          }
          if (!binding) {
            // 没有当前会话：新建并立即 retain，确认输入框真的接住了草稿，而不是假定成功。
            const sessionId = await ctx.sessions.create()
            ctx.uiWorkspace.openSession(sessionId)
            binding = ctx.sessions.binding(sessionId)
            if (!binding) return 'unavailable'
          }
          const result = prefill(input, binding, prompt)
          ctx.layout.selectPanel(panelId)
          return result
        } catch {
          return 'unavailable'
        }
      }
    }

    return {
      inject: ['slots', 'layout', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        const handleAsk = askAssistant(ctx)
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pluginCss = 'dsh-beeftv'
          style.textContent = css
          document.head.appendChild(style)
          return () => style.remove()
        }, 'beeftv: workbench styles')
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: panelId,
          children: { [conversationSlot]: { kind: 'single', scope: 'session-maybe' } },
          inject: () => ({
            returnToConversation: () => ctx.layout.selectPanel(null),
            createCreativeSession: async () => {
              const sessionId = await ctx.sessions.create()
              ctx.uiWorkspace.openSession(sessionId)
              ctx.layout.selectPanel(panelId)
            },
            askAssistant: handleAsk,
          }),
        }, Workbench))
        ctx.slots.inject(conversationSlot, () => ctx.slots.register({ name: conversationSlot }, NativeConversation))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: panelId,
          order: 6,
          label: 'BeefTV',
        }, Icon))
      },
    }
  },
})
