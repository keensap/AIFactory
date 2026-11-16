# UI Implementation Prompt — PDF Input and PDF Deliverables

**For:** the UI implementation agent  
**Scope:** attach PDFs to a stage run, and open the PDF the stage produces  
**Backend:** AI Factory HTTP API at `http://127.0.0.1:8787`  
**API contract:** `/openapi.yaml` · design: `docs/design/DOCUMENTS-AND-PDF.md`

---

## Your task

1. Let a requester attach **several PDFs** to a stage run, next to the text brief.
2. Show the **PDF deliverable** the stage produces, and let the operator open or re-export it.

Two rules drive the UX:

> **Only PDFs are accepted.** Images are rejected by the API with an explanatory message — show that message, do not hide the limitation.
>
> **The deliverable lives in the project's own tree**, at `documents/<stage>/<Title> — <Project>.pdf`. The API returns that path; display it and link to the file through the document endpoints (the API does not serve the project tree directly).

---

## 1. Attaching inputs

### Where

In the stage run creation panel (Planning & Feasibility, and later Requirements), under the brief textarea:

```
Business brief
┌──────────────────────────────────────────────┐
│ …                                            │
└──────────────────────────────────────────────┘
Input documents (PDF)                [+ Add PDFs]
  📄 requirements brief.pdf · 4 pages · 89 KB   [x]
  📄 constraints.pdf · 2 pages · 31 KB          [x]
```

### Upload

```
POST /api/projects/:id/attachments      multipart/form-data
  files: <one or more PDFs>             (field name is exactly "files")
  stage: "planning"                      (optional; defaults to the project's current stage)
```

- One request for all selected files: send every file under the same `files` field.
- Show per-file progress or, at minimum, a busy state; the request is rejected as a whole if any file breaks a limit.
- Limits: **20 MB per file, 10 files per request, 20 per run**. Enforce the obvious ones client-side (file type, size, count) and still handle the server errors.
- Default the stage to the stage the user is starting; do not offer a stage picker that disagrees with the run.

### Error handling

| `error.code` | HTTP | Show |
|---|---|---|
| `UNSUPPORTED_FILE_TYPE` | 415 | the server message verbatim — it explains that images are not used by stage analysis yet |
| `ATTACHMENT_TOO_LARGE` | 413 | which file, and the 20 MB limit |
| `PDF_HAS_NO_TEXT` | 422 | "This looks like a scanned PDF. The stage can only read PDFs with a text layer; run OCR first." |
| `INVALID_PDF` | 400 | "This file could not be read as a PDF." |
| `FILES_REQUIRED` | 400 | nothing selected |
| `TOO_MANY_FILES` | 400 | more than 10 files |

Reject images **before** uploading when you can (`accept=".pdf,application/pdf"`), but still surface the server message if one gets through: a silent drop would look like it worked.

### Listing and removing

```
GET    /api/projects/:id/attachments?stage=planning
DELETE /api/projects/:id/attachments/:attachmentId      → 204
GET    /api/projects/:id/attachments/:attachmentId/content   (the original PDF)
```

Show `title`, `pages`, `sizeBytes` (formatted) and `truncated` when true ("long document; only the first 20,000 characters are analysed"). Removing an attachment does not change a run that already started — say so if the user removes one while a run is queued.

### Starting the run

```json
POST /api/projects/:id/stages/planning/runs
{ "brief": "…", "attachmentIds": ["…", "…"] }
```

- Send the ids of the files currently in the list.
- The API returns `404 ATTACHMENT_NOT_FOUND` if an id is not this project's; refresh the list and let the user retry.
- Nothing is required: a run with no attachments, or with an empty brief, is valid.

---

## 2. The deliverable

When the run reaches `awaiting_human`, the API renders the PDF. The run detail carries it:

```json
{ "run": { "status": "awaiting_human",
  "documents": [ { "id": "…", "kind": "telos_report", "title": "TELOS feasibility report",
                   "storagePath": ".aifactory/documents/planning/…-telos.md",
                   "exportPath": "documents/planning/TELOS Feasibility Report — ABCClothing.pdf" } ] } }
```

`exportPath` may be absent (still rendering, or rendering failed) — treat absence as "not available yet", not as an error.

### Show it

In the document card next to the existing Markdown view:

```
TELOS Feasibility Report                        [Open PDF]  [Re-export]
documents/planning/TELOS Feasibility Report — ABCClothing.pdf · 47 KB
```

- `Open PDF`: link to `GET /api/projects/:id/documents/:documentId/content` (the stored file) **or** offer the path as copyable text with a hint that the file is in the project folder. Do not construct a filesystem URL the browser cannot open.
- Show the relative `exportPath` in full — it is what the user asked for and what they will look for in their repository.
- `Re-export`:

```
POST /api/stage-runs/:runId/export
→ { "export": { "path": "documents/planning/TELOS Feasibility Report — ABCClothing.pdf", "bytes": 48213 } }
```

Disable while in flight. `409 DOCUMENT_NOT_READY` before the document exists; `500 PDF_EXPORT_FAILED` with the message when rendering fails.

### When rendering failed

The run still completes. The activity stream contains a `document_export_failed` event:

```json
{ "type": "document_export_failed", "level": "warn", "payload": { "message": "…" } }
```

Show it as a **warning inside the document card** ("The PDF could not be produced: …") with a **Retry** button that calls the export endpoint. Do not fail the run view or hide the Markdown artifact — the Markdown is still complete and readable.

### Previewing

Rendering a preview inline is optional. If you add one, use `<object type="application/pdf">` or an `<iframe>` pointed at the document content endpoint, with the "Open PDF" link as the fallback for browsers that cannot embed PDFs.

---

## Acceptance criteria

- [ ] Several PDFs can be selected at once and uploaded in a single request; each appears with title, pages and size.
- [ ] An image is rejected with the server's explanation; it never appears as a silently accepted attachment.
- [ ] A scanned PDF (422 `PDF_HAS_NO_TEXT`) shows an OCR hint.
- [ ] Removing an attachment deletes it and updates the list; a run started later does not include it.
- [ ] Starting a run sends exactly the ids in the list, and `404 ATTACHMENT_NOT_FOUND` is recoverable.
- [ ] After the run reaches `awaiting_human`, the document card shows the exported path and an "Open PDF" action.
- [ ] "Re-export" calls the endpoint, shows progress, and updates the size/path.
- [ ] `document_export_failed` is surfaced as a warning with a working retry, and the Markdown document stays available.
- [ ] A run without attachments or brief still starts normally.
- [ ] The words "30 MB" or "images are supported" appear nowhere; the limits and the image limitation are stated accurately.
