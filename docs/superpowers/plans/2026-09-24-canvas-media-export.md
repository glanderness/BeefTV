# Canvas Media Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken canvas media download action with a desktop export flow that asks for a folder and writes a named copy there.

**Architecture:** The Wails desktop binding owns folder selection and streams the authenticated local resource from the running loopback backend into the chosen directory. The React canvas calls that binding with the stable resource ID and reports canceled, success, and failure states. Browser-only runtimes retain a Blob-based fallback.

**Tech Stack:** Go 1.25, Wails v2, React 19, TypeScript, Bun tests.

**Spec:** User request in the current task.

## Global Constraints

- Preserve existing resource storage and canvas behavior.
- Use the smallest focused change; do not overwrite an existing export.
- Verify the backend before adapting the frontend.
- Add failing tests before production code.

## Review Focus

- A canceled directory picker must not create a file or display an error.
- A stale node URL must not participate in desktop export; the stable resource ID must be used.
- Existing files in the selected directory must not be overwritten.
- Exported bytes must match the stored resource bytes.
- Non-desktop fallback must still export Blob-backed media.

---

### Task 1: Desktop export binding

**Files:**
- Modify: `backend/cmd/desktop/app.go`
- Modify: `backend/cmd/desktop/app_test.go`

**Interfaces:**
- Produces: `DesktopApp.ExportResource(resourceID, fileName) (DesktopExportResult, error)`.

- [ ] Write integration tests for successful export, cancellation, and collision-safe naming.
- [ ] Run the focused Go tests and verify they fail because the binding is absent.
- [ ] Implement the minimum authenticated streaming export and directory chooser seam.
- [ ] Run the focused Go tests and the desktop package tests.

### Task 2: Canvas export action

**Files:**
- Create: `web/src/services/desktop-media-export.ts`
- Create: `web/test/desktop-media-export.test.ts`
- Modify: `web/src/services/desktop-runtime.ts`
- Modify: `web/src/pages/canvas/use-canvas-node-editor.ts`
- Modify: `web/src/lib/canvas/tool-registry/definitions/node-hover-tools.tsx`

**Interfaces:**
- Consumes: Wails `ExportResource(resourceID, fileName)` binding.
- Produces: `exportCanvasMedia(node, canvasTitle)` with desktop and browser fallback behavior.

- [ ] Write frontend tests for resource-ID export, cancellation, stale URL isolation, and Blob fallback.
- [ ] Run the focused Bun tests and verify they fail because the service is absent.
- [ ] Implement the minimal service and connect the canvas action with user feedback.
- [ ] Rename the action copy from download to export.
- [ ] Run focused tests and the complete frontend suite.

### Task 3: Release verification

**Files:**
- No additional production files.

**Interfaces:**
- Verifies the complete desktop build contract.

- [ ] Run `go test ./...` in `backend`.
- [ ] Run `bun test` and `bun run build` in `web`.
- [ ] Run the repository local-release verification script.
- [ ] Inspect the final diff for unrelated changes and report limitations.
