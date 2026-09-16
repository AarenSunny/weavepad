# Browser persistence and offline recovery

WeavePad checkpoints each document in IndexedDB after local or remote changes.
The checkpoint contains enough information to resume the distributed protocol,
not merely a copy of the visible text:

- the immutable CRDT operation set;
- the stable replica identifier used to generate operation IDs;
- the greatest fully processed server cursor;
- local operations that have not yet been acknowledged;
- checkpoint time and format version.

## Startup sequence

The editor is read-only for the brief IndexedDB hydration step. It reconstructs
the local `SequenceDocument`, renders the saved text, and only then opens its
WebSocket. On connection it requests operations after the saved cursor, applies
that catch-up, and submits the saved pending queue. Duplicate operations remain
safe because both the CRDT and server store are idempotent.

This order avoids two common recovery bugs: overwriting local offline edits with
a server snapshot, and generating new operations under a different replica ID
after a reload.

## Failure behavior

If IndexedDB is blocked or unavailable, the editor still connects and works for
the current page session. The footer reports `Browser storage unavailable`
instead of making a false durability claim.

The production bundle is not yet a service worker/PWA. IndexedDB restores data
once the application assets are loaded, but a brand-new page load with no network
still requires those assets to be present in the browser cache. Full offline app
shell caching is deliberately separate from CRDT state recovery.

## Isolation and testing

Checkpoints use the document ID as their IndexedDB key, so shareable rooms cannot
overwrite one another locally. Automated tests use an in-memory standards-based
IndexedDB implementation to verify complete restore, atomic replacement,
document isolation, removal, Unicode operations, cursors, and pending queues.
