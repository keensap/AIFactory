/**
 * Render the documents' diagrams to PNG (embedded) and SVG (zoomable), and keep the
 * Mermaid source in `src/`.
 *
 * Not an application dependency: it needs a headless Chrome, which the API does not.
 * Usage (see README.md):
 *   CHROME=... MERMAID_JS=... node render-diagrams.mjs [outDir] [doc ...]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/usr/bin/chrome-headless-shell'
const MERMAID = readFileSync(process.env.MERMAID_JS ?? './node_modules/mermaid/dist/mermaid.min.js', 'utf8')
const [outDir, ...files] = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['../diagrams', '../ARCHITECTURE-v2.md', '../AI-Factory-Requirements-v2.md']
mkdirSync(join(outDir, 'src'), { recursive: true })

function blocks(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const out = []; let cur = null, heading = 'diagram'
  lines.forEach((l, i) => {
    const m = /^#{2,4}\s+(.*)$/.exec(l)
    if (m) heading = m[1].replace(/[`*]/g, '').trim()
    if (l.trim() === '```mermaid') { cur = { fence: i + 1, start: i + 1, heading, body: [] }; return }
    if (cur && l.trim() === '```') { cur.end = i + 1; out.push(cur); cur = null; return }
    if (cur) cur.body.push(l)
  })
  return out
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 52)

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
await page.setViewport({ width: 1800, height: 1200, deviceScaleFactor: 2 })
await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:20px;background:#fff;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}#host{display:inline-block}</style></head><body><div id="host"></div></body></html>')
await page.addScriptTag({ content: MERMAID })
await page.evaluate(() => window.mermaid.initialize({
  startOnLoad: false, theme: 'default', htmlLabels: false, securityLevel: 'strict', fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  flowchart: { htmlLabels: false, curve: 'basis', nodeSpacing: 30, rankSpacing: 40 },
  sequence: { useMaxWidth: false, wrap: true, width: 180 },
  er: { useMaxWidth: false },
}))

let n = 0
const manifest = []
for (const file of files) {
  const doc = basename(file, '.md')
  for (const b of blocks(file)) {
    n += 1
    // Name by document and heading, not by a global counter, so inserting a
    // diagram later does not renumber every other file.
    const docKey = doc.includes('ARCHITECTURE') ? 'arch' : 'req'
    const name = `${docKey}--${slug(b.heading)}`
    const code = b.body.join('\n')
    const svg = await page.evaluate(async (code, id) => {
      const { svg } = await window.mermaid.render(id, code)
      return svg
    }, code, `m${n}`)
    if (svg.includes('foreignObject')) throw new Error(`${name}: foreignObject present`)
    const m = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg)
    const w = Math.ceil(Number(m[3])), h = Math.ceil(Number(m[4]))
    writeFileSync(join(outDir, `${name}.svg`), svg.replace('<svg', `<svg width="${w}" height="${h}"`), 'utf8')
    writeFileSync(join(outDir, 'src', `${name}.mmd`), code + '\n', 'utf8')

    // PNG: screenshot the rendered SVG element, 2x for legibility.
    await page.evaluate((s) => { document.getElementById('host').innerHTML = s }, svg)
    const el = await page.$('#host svg')
    await el.screenshot({ path: join(outDir, `${name}.png`), type: 'png' })
    const textOk = (await page.evaluate(() => document.querySelectorAll('#host svg text').length)) > 0
    manifest.push({ name, heading: b.heading, doc, svgLine: b.fence, width: w, height: h, textNodes: textOk })
    console.log(`  ${name}  ${w}x${h}`)
  }
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
await browser.close()
console.log(`\n${manifest.length} diagrams`)
