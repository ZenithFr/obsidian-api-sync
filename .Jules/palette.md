## 2024-03-24 - Implicit Labeling vs Explicit Association in Tailwind UI
**Learning:** Jinja templates combining form elements heavily styled with Tailwind utility classes often lack explicit `id` and `for` associations because visual placement replaces semantic grouping. This breaks screen-reader accessibility for visually-coupled elements.
**Action:** Always scan `.html` files for `<label>` tags with text but missing `for` attributes and manually bind them to the matching `id` of their input siblings to restore native accessibility.

## 2024-08-01 - Missing ARIA Labels on Icon Buttons and Inputs
**Learning:** Icon-only buttons and important inputs in this app often use `title` or `placeholder` attributes which are not sufficient replacements for explicit `aria-label`s. This breaks accessibility for screen reader users as they won't hear clear descriptions for important workspace actions.
**Action:** Always scan for icon-only buttons (like those using SVGs) and inputs, and ensure they have a descriptive `aria-label` attribute even if they already have `title` or `placeholder` attributes.

## 2024-10-24 - Missing accessibility in dynamically generated Modals
**Learning:** Dynamically generated modals (using JS template strings) often lack explicit label associations and ARIA labels for their form inputs, breaking accessibility.
**Action:** Always scan JS template string generation of UI elements for form controls and ensure proper `label` and `aria-label` attributes are included.

## 2024-11-20 - Explicit Labeling vs ARIA Labels and sr-only classes
**Learning:** Form inputs and checkboxes often have either a `placeholder` or an explicit `<label for="...">`, but for full accessibility compliance (especially in dynamic/styled forms), explicitly pairing `aria-label` along with visually hidden `sr-only` labels (if no visual label exists) is required. This ensures proper interaction for all screen reader variants.
**Action:** When updating form inputs or rendering dynamic checkboxes (e.g., Markdown task lists), always ensure they have an explicit `aria-label` AND a paired `<label for="...">` tag (using `.sr-only` if it must be visually hidden).

## 2026-08-19 - Redundant aria-label Accessibility Anti-pattern
**Learning:** Adding an `aria-label` to an input element that already has an explicitly paired visible or visually hidden `<label for="...">` element is a redundant anti-pattern. This can cause screen readers to announce fields twice, degrading the user experience.
**Action:** Do NOT add `aria-label` to inputs that already have an explicitly paired `<label for="...">` element.
## 2025-02-18 - Async Visual Feedback for Token Generation
**Learning:** Lacking a visual loading state during an async fetch operation makes the application feel unresponsive and can lead to duplicated submissions. It's important to provide immediate visual feedback while preserving existing functionality like graceful defaults.
**Action:** Always implement explicit loading states (spinners and text changes) on buttons triggering async calls to provide immediate visual feedback. Ensure that UI validations do not conflict with the underlying application capabilities (e.g. allowing default fallbacks).
