# Portfolio demo guide

This five-minute walkthrough demonstrates the project as a system rather than a
single text box.

## Setup

In one terminal:

```bash
npm install
npm start
```

In another:

```bash
npm run dev
```

Open `http://127.0.0.1:5173/?document=interview-demo` in two browser windows.

## Walkthrough

1. Give each window a different display name. Both collaborator rosters update
   immediately.
2. Type from both windows. Explain that every Unicode grapheme becomes an
   immutable operation and deterministic ordering makes replicas converge.
3. Disconnect one window from the network, continue editing, then reconnect.
   The client catches up from its durable cursor before flushing queued edits.
   Reloading the page also reconstructs the local CRDT checkpoint from IndexedDB.
4. Restart the sync server and reload. The document returns from SQLite while
   the ephemeral presence roster is rebuilt from active sessions.
5. Run `npm test`. The suite covers concurrent CRDT edits, out-of-order deletes,
   Unicode, live WebSockets, reconnect catch-up, process restarts, and presence
   expiry.

## Deterministic collaboration proof

```bash
npm run collaboration-demo
```

This machine-readable scenario starts two WebSocket clients, takes one offline,
creates concurrent edits, reconnects from its durable cursor, flushes its
offline operations, verifies all replicas converge, and restarts the service to
verify SQLite recovery. It runs over loopback in one process and deliberately
does not claim to measure wide-area latency, multi-node availability, or
concurrent-user capacity.

## Keyboard and status checks

- Tab through the header controls, editor, display-name field, and sync-health
  region with a visible focus indicator.
- Open History, confirm focus moves to Close, cycles inside the modal, and
  returns to History after Escape.
- Stop the sync service and confirm the live status announces offline state,
  queued edits remain editable, and the retry attempt appears in Sync health.
- Restart the service and confirm reconnect count, last-sync time, and pending
  changes update without reloading.

## Suggested screenshots

- Desktop editor with two named collaborators and a short formatted-looking note
- Two browser windows showing the same text and different presence colors
- Terminal output from the complete passing test suite
- The CRDT and synchronization diagrams in the README and design notes

Keep the browser URL visible in one image so reviewers can see that document
rooms are shareable by link.
