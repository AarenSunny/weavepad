# Version history

WeavePad records a revision after every accepted CRDT operation batch. The
browser coalesces rapid local input for 350 milliseconds, so normal typing forms
useful editing checkpoints instead of one version per keystroke.

## Storage model

Revision metadata and operations are committed in the same SQLite transaction.
A revision stores:

- a document-local revision number;
- the durable operation sequence through which it is complete;
- operation count and contributing actor identifiers;
- a server timestamp.

The revision does not duplicate document text. To preview an old version, the
server replays that document's immutable operations through the chosen sequence
into a fresh `SequenceDocument`. This makes history auditable and exercises the
same deterministic materialization path used by live replicas.

## HTTP API

List the newest 50 revisions:

```http
GET /api/documents/demo/history
```

The optional `limit` parameter accepts 1 through 100. Preview a listed revision
using its durable sequence:

```http
GET /api/documents/demo/versions/42
```

Both endpoints return `Cache-Control: no-store`. A sequence must correspond to a
recorded revision; arbitrary operation-log positions cannot be queried.

## Editor behavior

The History button opens a read-only dialog. Selecting a revision fetches its
materialized text without replacing the live CRDT, changing the current cursor,
or broadcasting operations. Closing the dialog returns to the live document.

Restoring an old version is intentionally a later feature: it should create new
CRDT operations rather than deleting history or rewinding shared state.
