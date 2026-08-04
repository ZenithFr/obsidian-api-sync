## 2024-03-24 - Implicit Labeling vs Explicit Association in Tailwind UI
**Learning:** Jinja templates combining form elements heavily styled with Tailwind utility classes often lack explicit `id` and `for` associations because visual placement replaces semantic grouping. This breaks screen-reader accessibility for visually-coupled elements.
**Action:** Always scan `.html` files for `<label>` tags with text but missing `for` attributes and manually bind them to the matching `id` of their input siblings to restore native accessibility.

## 2024-08-01 - Missing ARIA Labels on Icon Buttons and Inputs
**Learning:** Icon-only buttons and important inputs in this app often use `title` or `placeholder` attributes which are not sufficient replacements for explicit `aria-label`s. This breaks accessibility for screen reader users as they won't hear clear descriptions for important workspace actions.
**Action:** Always scan for icon-only buttons (like those using SVGs) and inputs, and ensure they have a descriptive `aria-label` attribute even if they already have `title` or `placeholder` attributes.

## 2024-11-20 - Explicit label tags over placeholder and aria-label
**Learning:** Even when inputs have `placeholder` and `aria-label` attributes, relying entirely on them without explicit `<label>` tags violates optimal accessibility patterns. Some screen readers handle standard `<label for="...">` much more reliably than `aria-label` on inputs.
**Action:** When finding inputs without explicit labels, especially search or inline inputs, add a visually hidden `<label class="sr-only" for="...">` bound to the input's `id`.
