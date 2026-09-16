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

## Suggested screenshots

- Desktop editor with two named collaborators and a short formatted-looking note
- Two browser windows showing the same text and different presence colors
- Terminal output from the complete passing test suite
- The CRDT and synchronization diagrams in the README and design notes

Keep the browser URL visible in one image so reviewers can see that document
rooms are shareable by link.
