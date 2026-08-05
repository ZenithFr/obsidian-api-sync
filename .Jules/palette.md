## 2024-03-24 - Implicit Labeling vs Explicit Association in Tailwind UI
**Learning:** Jinja templates combining form elements heavily styled with Tailwind utility classes often lack explicit `id` and `for` associations because visual placement replaces semantic grouping. This breaks screen-reader accessibility for visually-coupled elements.
**Action:** Always scan `.html` files for `<label>` tags with text but missing `for` attributes and manually bind them to the matching `id` of their input siblings to restore native accessibility.

## 2024-08-01 - Missing ARIA Labels on Icon Buttons and Inputs
**Learning:** Icon-only buttons and important inputs in this app often use `title` or `placeholder` attributes which are not sufficient replacements for explicit `aria-label`s. This breaks accessibility for screen reader users as they won't hear clear descriptions for important workspace actions.
**Action:** Always scan for icon-only buttons (like those using SVGs) and inputs, and ensure they have a descriptive `aria-label` attribute even if they already have `title` or `placeholder` attributes.

## 2026-08-05 - Explicit <label> Elements Needed Even with Placeholders and aria-label
**Learning:** Standalone inputs often rely on `placeholder` attributes or `aria-label`s without an explicit `<label for="...">` association. While `aria-label` provides a name to assistive technologies, explicit `<label>` elements are a more robust accessibility standard. Without them, we break screen-reader accessibility for visually-coupled elements.
**Action:** Always ensure that inputs, even those with `placeholder` and `aria-label`, have an explicit `<label for="...">` tag. Use `.sr-only` class to hide the label visually if the design dictates a standalone input field.
