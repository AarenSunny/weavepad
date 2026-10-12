# Accessibility checks

WeavePad uses semantic controls, visible keyboard focus, live sync and storage
status, and a focus-contained version-history dialog. Small muted interface
labels use tokens chosen for WCAG 2.2 AA contrast. The automated contrast test
reads those exact CSS custom properties and verifies a ratio of at least 4.5:1
against every surface where the tokens appear.

This check protects the currently declared color pairs; it is not a claim that
automated tests prove complete accessibility. Release review should still cover
keyboard-only editing, focus order and restoration, screen-reader announcements,
browser zoom, reflow, and high-contrast or forced-color modes.
