## 2025-02-18 - Palette: UI and Sync Insights
**Learning:** Hardcoding standard icons or styles per status string isn't extensible. We need a central map that defines the color class and icon for every known sync status so the UI can just pull from it instead of long switch/case blocks.
**Action:** Use a `STATUS_UI` mapping object for consistency across tables, toasts, and headers. Ensure any new status (e.g. `pull-conflict`) is registered there first.

## 2025-02-18 - Graceful Error Handling
**Learning:** Letting raw API errors print to the user is jarring. The frontend needs to catch these cleanly and map them into user-friendly toast messages.
**Action:** Always wrap API fetch calls in `try/catch` and use `showToast(error.message, 'error')` or a fallback string. Never let an uncaught promise rejection leak into the UI silently.

## 2025-02-18 - Async Visual Feedback for Token Generation
**Learning:** Lacking a visual loading state during an async fetch operation makes the application feel unresponsive and can lead to duplicated submissions. It's important to provide immediate visual feedback while preserving existing functionality like graceful defaults.
**Action:** Always implement explicit loading states (spinners and text changes) on buttons triggering async calls to provide immediate visual feedback. Ensure that UI validations do not conflict with the underlying application capabilities (e.g. allowing default fallbacks).

## 2025-02-18 - Caching original HTML in dataset
**Learning:** When implementing temporary loading states on buttons via JavaScript, caching the original HTML in a local variable can cause the button to become permanently stuck in the loading state if clicked rapidly multiple times, because the subsequent click captures the "loading" HTML as the original.
**Action:** Cache the original HTML in a dataset attribute (e.g., `data-original-html`) rather than a local variable to prevent the button from becoming permanently stuck in the loading state.
