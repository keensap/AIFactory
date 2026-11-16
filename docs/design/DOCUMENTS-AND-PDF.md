# Stage Documents — PDF input and PDF output

**Status:** implemented 2026-11-16  
**Scope:** planning stage (the only executable stage); the same pipeline applies to requirements once its runtime exists  
**Related:** `MODEL-PROVIDERS.md` §10.6 (telemetry), `STAGE-RUNTIME.md`

---

## 1. What this adds

1. **PDF input.** A requester can attach several PDFs to a stage run, alongside the text brief. Their text becomes first-class evidence for every role (analyzer, author, reviewer, revision).
2. **PDF output.** When a run reaches `awaiting_human`, the Markdown deliverable is rendered to a professionally formatted PDF **outside** `.aifactory`, at:

```
<project-root>/documents/<stage>/<Document Title> — <Project Name>.pdf
e.g. documents/planning/TELOS Feasibility Report — ABCClothing.pdf
```

Re-running a stage overwrites that canonical file; the Markdown source and the run history stay in `.aifactory`, which remains the source of truth.

---

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| PDF renderer | **pure JavaScript (`pdf-lib`)** with a purpose-built A4 layout engine | No browser, no LibreOffice, no Python: generation is deterministic and available wherever the API runs. WeasyPrint was unavailable in this environment (broken shim) and LibreOffice needs a writable profile, which is fragile in containers. |
| Input formats | **PDF only**, multiple per request | The harness consumes text, so PDF text extraction is reliable. |
| Images | **Rejected at upload with an explicit message** | The harness has no image input and the model layer has no vision path. Accepting an image would imply an influence on the analysis that does not exist. |
| When the PDF is written | At **`awaiting_human`**, plus `POST /api/stage-runs/:id/export` | The operator can read the deliverable before deciding; the endpoint re-renders after any fix. |
| Export failure | **Never fails the run** | Same isolation rule as logging and Phoenix: the Markdown artifact and the run survive, the failure is logged and recorded as `document_export_failed`. |
| Filename | `<title> — <project>.pdf`, sanitized | Matches the requested convention; path separators and reserved characters are removed, the em dash and accents are kept. |
| Overwrite | Yes, canonical path | Predictable location per stage; history lives in `.aifactory`. |
| Extraction timing | **At upload**, cached as `text.txt` next to the file | Runs pay no extraction cost and a re-run sees byte-identical input. |

---

## 3. Flow

```
upload  ──► POST /api/projects/:id/attachments            (multipart, 1..10 PDFs)
             ├─ validate: PDF, ≤20 MB, non-empty
             ├─ extract text once (unpdf), cap 20k chars
             └─ store .aifactory/attachments/<id>/{file,text.txt} + row

run     ──► POST /api/projects/:id/stages/planning/runs   { brief, attachmentIds[] }
             ├─ attachments validated against the project (404 if foreign)
             ├─ context packet gains `attachments[]` (metadata + capped text)
             └─ linked in stage_run_attachments (re-runs reuse the same set)

prompts ──► every role gets an "INPUT DOCUMENTS" section
             per-document cap 20k chars, 60k total, truncation stated inline
             JSON context carries metadata only (no duplicated text)

finish  ──► render Markdown → PDF (pdf-lib)
             write <root>/documents/<stage>/<title> — <project>.pdf
             record stage_document_exports + `document_exported` run event
```

---

## 4. Renderer

`src/report/markdown.ts` parses the subset our prompts produce: headings, paragraphs, bullet/ordered lists (with continuation lines), tables (with alignment and escaped pipes), fenced code, block quotes and rules, plus inline bold/italic/code.

`src/report/pdf.ts` lays that out on A4: title page, running header, footer with `Page x of y`, table borders with a shaded header row that repeats across page breaks, code blocks with a tinted background, and keep-with-next protection for headings.

**Standard fonts only** (Helvetica family + Courier). Text is left-aligned, so wrapping is exact without justification support. Characters outside WinAnsi are mapped (`✓→x`, `→→->`, `≤→<=`) or replaced with `?`, never silently dropped.

---

## 5. Limits and failure modes

| Limit | Value |
|---|---|
| Attachment size | 20 MB |
| Files per upload request | 10 |
| Inputs per run | 20 |
| PDF pages | 300 |
| Text per document in a prompt | 20 000 chars |
| Text across documents in a prompt | 60 000 chars |

| Failure | Behaviour |
|---|---|
| Scanned PDF with no text layer | `422 PDF_HAS_NO_TEXT` at upload; the file is not stored |
| Corrupt PDF | `400 INVALID_PDF` |
| Image or other file | `415 UNSUPPORTED_FILE_TYPE` |
| Attachment from another project | `404 ATTACHMENT_NOT_FOUND` when starting the run |
| PDF contains no text in the rendered PDF | N/A; renderer failure is caught |
| Rendering or writing fails | Run still completes; `document_export_failed` event, log warning |
| Path traversal via stage name | `EXPORT_PATH_ESCAPE`; components are joined and verified |

---

## 6. Not done

- **Images as model input.** Requires a vision path (content blocks in the model layer and an engine that sends them); deferred by decision.
- **Requirements stage.** The pipeline is stage-agnostic, but only planning has a runtime.
- **OCR** for scanned PDFs.
- **Signatures, headers/logos, TOC with page numbers.** A TOC needs a two-pass layout.
- **Email or approval workflow** for the produced document.

---

## 7. Verification

- 458 tests pass, including: markdown parsing (11 cases), PDF rendering with text extracted back out of the generated file, filename/path sanitisation and escape rejection, overwrite behaviour, upload validation (images rejected), prompt budgeting, PG storage/link/delete/export, and an HTTP end-to-end test that uploads two PDFs, runs the stage and asserts the PDF exists at the exact requested path with valid PDF bytes.
- The live API check uploaded a real PDF, ran a planning stage, and confirmed `documents/planning/TELOS Feasibility Report — ABCClothing.pdf`.
