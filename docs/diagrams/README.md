# Rendered diagrams

The diagrams in [`../ARCHITECTURE-v2.md`](../ARCHITECTURE-v2.md) and
[`../AI-Factory-Requirements-v2.md`](../AI-Factory-Requirements-v2.md) are stored here as
images, so they render wherever the document is read — a plain Markdown viewer, a code review,
a PDF export, or a wiki that does not support Mermaid.

Each diagram exists in three forms:

| File | Purpose |
|---|---|
| `*.png` | what the documents embed; renders everywhere |
| `*.svg` | vector version, for zooming or printing |
| `src/*.mmd` | the Mermaid source — the thing to edit |

**Naming.** `<doc>--<section heading>`, for example `arch--7-1-a-run-in-order`. Names are
derived from the document and its heading, not from a position, so inserting a diagram later
does not rename the others.

**Rendering choices, and why.**

- `htmlLabels: false` — Mermaid's default SVG puts labels inside `<foreignObject>`, which many
  viewers (including several Markdown renderers and image pipelines) silently refuse to draw.
  Plain `<text>` is portable.
- **Vertical orientation for chains.** A left-to-right flow of five nodes comes out around
  2000 × 140 px; scaled to a document column it becomes 60 px tall and unreadable. Those
  diagrams are drawn top-to-bottom instead, which trades width for legibility.
- A light theme with the default Mermaid palette, on white, so they read in both light and dark
  surrounding pages without colour assumptions.

## Regenerating

The renderer is deliberately not part of the application's dependencies — it needs a headless
Chrome, which the API does not.

```bash
# one-time, anywhere outside the repo
mkdir -p /tmp/diagram-render && cd /tmp/diagram-render
npm init -y
npm i mermaid@11 puppeteer-core @puppeteer/browsers
npx @puppeteer/browsers install chrome-headless-shell@stable
```

Then run the renderer with the Chrome path substituted for `$CHROME`:

```bash
node render-diagrams.mjs       # reads the two documents, writes png/svg/src here
```

Editing a diagram means editing `src/<name>.mmd`, rendering, and updating the image reference
in the document if the heading changed. The `src/` files are the source of truth for the
drawing; the documents embed the result.
