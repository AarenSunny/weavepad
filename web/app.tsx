import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SequenceDocument, type Operation } from "../src/crdt.ts";
import type { PresenceParticipant, PresenceProfile, PresenceSelection } from "../src/presence.ts";
import { applyTextChange, cursorAnchor } from "./editor-state.ts";
import { IndexedDbDocumentStore } from "./offline-store.ts";
import { recentTimeLabel, reconnectDelayMs, syncProgressLabel, type ConnectionStatus } from "./sync-health.ts";

interface StoredWireOperation {
  sequence: number;
  operation: Operation;
}

interface WireCheckpoint {
  sequence: number;
  operations: Operation[];
}

interface DocumentRevision {
  revision: number;
  sequence: number;
  operationCount: number;
  actors: string[];
  createdAt: string;
}

const colors = ["#7C3AED", "#0891B2", "#EA580C", "#16A34A", "#DB2777", "#4F46E5"];

function identity(): PresenceProfile {
  const stored = localStorage.getItem("weavepad.identity");
  if (stored) return JSON.parse(stored) as PresenceProfile;
  const userId = crypto.randomUUID();
  const profile = {
    userId,
    name: `Guest ${userId.slice(0, 4).toUpperCase()}`,
    color: colors[Math.floor(Math.random() * colors.length)],
  };
  localStorage.setItem("weavepad.identity", JSON.stringify(profile));
  return profile;
}

function documentFromLocation(): string {
  const candidate = new URLSearchParams(location.search).get("document") ?? "welcome";
  return /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : "welcome";
}

function websocketUrl(documentId: string): string {
  const configured = import.meta.env.VITE_SYNC_URL as string | undefined;
  if (configured) return `${configured.replace(/\/$/, "")}/documents/${documentId}`;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/documents/${documentId}`;
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

export function App() {
  const documentId = useMemo(documentFromLocation, []);
  const offlineStore = useMemo(() => new IndexedDbDocumentStore(), []);
  const documentRef = useRef(new SequenceDocument(crypto.randomUUID()));
  const pendingRef = useRef<Operation[]>([]);
  const cursorRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const selectionRef = useRef<PresenceSelection | null>(null);
  const flushTimerRef = useRef<number | undefined>(undefined);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const historyCloseRef = useRef<HTMLButtonElement | null>(null);
  const historyDialogRef = useRef<HTMLElement | null>(null);
  const [profile, setProfile] = useState(identity);
  const profileRef = useRef(profile);
  const [text, setText] = useState("");
  const textRef = useRef(text);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [successfulReconnects, setSuccessfulReconnects] = useState(0);
  const [nextRetryDelayMs, setNextRetryDelayMs] = useState<number | null>(null);
  const [lastConnectedAt, setLastConnectedAt] = useState<number | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(Date.now);
  const [connectionError, setConnectionError] = useState("");
  const [participants, setParticipants] = useState<PresenceParticipant[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [storageStatus, setStorageStatus] = useState<"loading" | "saved" | "unavailable">("loading");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [versionText, setVersionText] = useState("");

  const persistDocument = useCallback(() => {
    const document = documentRef.current;
    void offlineStore.save({
      version: 1,
      documentId,
      actor: document.actor,
      cursor: cursorRef.current,
      operations: document.snapshot().operations,
      pendingOperations: pendingRef.current.map((operation) => ({ ...operation })),
      savedAt: new Date().toISOString(),
    }).then(() => setStorageStatus("saved"), () => setStorageStatus("unavailable"));
  }, [documentId, offlineStore]);

  useEffect(() => {
    let cancelled = false;
    void offlineStore.load(documentId).then((state) => {
      if (cancelled || !state) return;
      const document = SequenceDocument.fromSnapshot(state.actor, { operations: state.operations });
      documentRef.current = document;
      cursorRef.current = state.cursor;
      pendingRef.current = state.pendingOperations;
      const restoredText = document.toString();
      textRef.current = restoredText;
      setText(restoredText);
      setPendingCount(state.pendingOperations.length);
    }).then(() => {
      if (!cancelled) {
        setStorageStatus("saved");
        setHydrated(true);
      }
    }).catch(() => {
      if (!cancelled) {
        setStorageStatus("unavailable");
        setHydrated(true);
      }
    });
    return () => { cancelled = true; };
  }, [documentId, offlineStore]);

  const sendPresence = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "presence", user: profileRef.current, selection: selectionRef.current }));
    }
  }, []);

  useEffect(() => {
    profileRef.current = profile;
    localStorage.setItem("weavepad.identity", JSON.stringify(profile));
    sendPresence();
  }, [profile, sendPresence]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hydrated) return undefined;
    let stopped = false;
    let retry: number | undefined;
    let heartbeat: number | undefined;
    let attempts = 0;

    const connect = () => {
      if (stopped) return;
      setStatus("connecting");
      setNextRetryDelayMs(null);
      const socket = new WebSocket(websocketUrl(documentId));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (attempts > 0) setSuccessfulReconnects((count) => count + 1);
        attempts = 0;
        setStatus("online");
        setReconnectAttempts(0);
        setNextRetryDelayMs(null);
        setLastConnectedAt(Date.now());
        setConnectionError("");
        socket.send(JSON.stringify({ type: "sync", after: cursorRef.current }));
        sendPresence();
        heartbeat = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" }));
        }, 10_000);
      });

      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as Record<string, any>;
          if (message.type === "ready") {
            setParticipants(message.presence.participants as PresenceParticipant[]);
          } else if (message.type === "presence") {
            setParticipants(message.participants as PresenceParticipant[]);
          } else if (message.type === "sync" || message.type === "operations") {
            const entries = message.operations as StoredWireOperation[];
            const checkpoint = message.checkpoint as WireCheckpoint | undefined;
            if (checkpoint) {
              documentRef.current.merge(checkpoint.operations);
              cursorRef.current = Math.max(cursorRef.current, checkpoint.sequence);
            }
            for (const entry of entries) {
              documentRef.current.apply(entry.operation);
              cursorRef.current = Math.max(cursorRef.current, entry.sequence);
            }
            const accepted = new Set([
              ...(checkpoint?.operations.map((operation) => operation.id) ?? []),
              ...entries.map((entry) => entry.operation.id),
            ]);
            pendingRef.current = pendingRef.current.filter((operation) => !accepted.has(operation.id));
            setPendingCount(pendingRef.current.length);
            const materialized = documentRef.current.toString();
            textRef.current = materialized;
            setText(materialized);
            setLastSyncedAt(Date.now());
            setConnectionError("");
            persistDocument();
            if (message.type === "sync" && pendingRef.current.length > 0) {
              socket.send(JSON.stringify({ type: "operations", operations: pendingRef.current }));
            }
          } else if (message.type === "error") {
            setConnectionError(String(message.message ?? "The sync service rejected a message."));
          }
        } catch {
          setConnectionError("The sync service sent an unreadable message; local edits are still available.");
        }
      });

      socket.addEventListener("close", () => {
        if (heartbeat) window.clearInterval(heartbeat);
        if (stopped) return;
        setStatus("offline");
        attempts += 1;
        const delayMs = reconnectDelayMs(attempts);
        setReconnectAttempts(attempts);
        setNextRetryDelayMs(delayMs);
        retry = window.setTimeout(connect, delayMs);
      });
      socket.addEventListener("error", () => {
        setConnectionError("Connection interrupted; WeavePad will retry automatically.");
        socket.close();
      });
    };

    connect();
    return () => {
      stopped = true;
      if (retry) window.clearTimeout(retry);
      if (heartbeat) window.clearInterval(heartbeat);
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
      socketRef.current?.close();
    };
  }, [documentId, hydrated, persistDocument, sendPresence]);

  const changeText = (nextText: string) => {
    const operations = applyTextChange(documentRef.current, textRef.current, nextText);
    textRef.current = documentRef.current.toString();
    setText(textRef.current);
    if (operations.length === 0) return;
    pendingRef.current.push(...operations);
    setPendingCount(pendingRef.current.length);
    persistDocument();
    if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = window.setTimeout(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && pendingRef.current.length > 0) {
        socket.send(JSON.stringify({ type: "operations", operations: pendingRef.current }));
      }
    }, 350);
  };

  const updateSelection = (element: HTMLTextAreaElement) => {
    selectionRef.current = {
      anchor: cursorAnchor(documentRef.current, textRef.current, element.selectionStart),
      focus: cursorAnchor(documentRef.current, textRef.current, element.selectionEnd),
    };
    sendPresence();
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  const previewRevision = async (revision: DocumentRevision) => {
    setSelectedRevision(revision.revision);
    setHistoryError("");
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/versions/${revision.sequence}`);
      if (!response.ok) throw new Error("Could not load this revision");
      const body = await response.json() as { text: string };
      setVersionText(body.text);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load this revision");
    }
  };

  const showHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/history`);
      if (!response.ok) throw new Error("Could not load version history");
      const body = await response.json() as { revisions: DocumentRevision[] };
      setRevisions(body.revisions);
      if (body.revisions[0]) await previewRevision(body.revisions[0]);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load version history");
    } finally {
      setHistoryLoading(false);
    }
  };

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    window.requestAnimationFrame(() => historyButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (historyOpen) historyCloseRef.current?.focus();
  }, [historyOpen]);

  const handleHistoryKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeHistory();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(historyDialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ) ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="WeavePad home">
          <span className="brand-mark">W</span>
          <span>WeavePad</span>
        </a>
        <div className="document-pill"><span>Document</span><strong>{documentId}</strong></div>
        <div aria-atomic="true" aria-live="polite" className={`status ${status}`} role="status">
          <i aria-hidden="true" />{status}
        </div>
      </header>

      <section className="workspace">
        <div className="editor-panel">
          <div className="editor-heading">
            <div>
              <p className="eyebrow">Shared workspace</p>
              <h1>Untitled document</h1>
            </div>
            <div className="editor-actions">
              <button className="quiet-button" onClick={showHistory} ref={historyButtonRef} type="button">History</button>
              <button className="share-button" onClick={copyLink} type="button">{copied ? "Copied" : "Copy link"}</button>
            </div>
          </div>
          <textarea
            aria-label="Collaborative document"
            autoFocus
            disabled={!hydrated}
            onBlur={() => { selectionRef.current = null; sendPresence(); }}
            onChange={(event) => changeText(event.target.value)}
            onSelect={(event) => updateSelection(event.currentTarget)}
            placeholder={hydrated ? "Start writing. Open this link in another window to collaborate…" : "Restoring your local document…"}
            spellCheck
            value={text}
          />
          <footer className="editor-footer">
            <span>{documentRef.current.length} characters</span>
            <span aria-live="polite">
              {storageStatus === "loading" ? "Restoring local state" : storageStatus === "saved" ? "Saved locally" : "Browser storage unavailable"}
            </span>
            <span aria-live="polite">{syncProgressLabel(status, pendingCount)}</span>
          </footer>
        </div>

        <aside className="sidebar">
          <p className="eyebrow">Collaborators</p>
          <h2>{participants.length || 1} in this document</h2>
          <div className="people">
            {participants.map((participant) => (
              <div className="person" key={participant.sessionId}>
                <span className="avatar" style={{ background: participant.color }}>{initials(participant.name)}</span>
                <span><strong>{participant.name}</strong><small>{participant.selection ? "Editing now" : "Viewing"}</small></span>
                <i className="active-dot" />
              </div>
            ))}
            {participants.length === 0 && <p className="empty">Connect to the sync service to appear here.</p>}
          </div>
          <label className="profile-field">
            <span>Your display name</span>
            <input
              maxLength={80}
              onChange={(event) => setProfile({ ...profile, name: event.target.value || "Anonymous" })}
              value={profile.name}
            />
          </label>
          <div className="local-first-note">
            <span aria-hidden="true">↻</span>
            <p><strong>Local-first by design</strong>Your edits remain usable while disconnected and merge on reconnect.</p>
          </div>
          <section aria-labelledby="sync-health-heading" className="sync-health" tabIndex={0}>
            <p className="eyebrow" id="sync-health-heading">Sync health</p>
            <dl>
              <div><dt>Last connected</dt><dd>{recentTimeLabel(lastConnectedAt, clockNow)}</dd></div>
              <div><dt>Last sync</dt><dd>{recentTimeLabel(lastSyncedAt, clockNow)}</dd></div>
              <div><dt>Reconnects</dt><dd>{successfulReconnects}</dd></div>
              {nextRetryDelayMs !== null && (
                <div><dt>Retry</dt><dd>attempt {reconnectAttempts} in ≤{nextRetryDelayMs / 1_000}s</dd></div>
              )}
            </dl>
            {connectionError && <p className="sync-error" role="alert">{connectionError}</p>}
          </section>
        </aside>
      </section>

      {historyOpen && (
        <div className="history-backdrop" role="presentation" onMouseDown={closeHistory}>
          <section
            aria-label="Version history"
            aria-modal="true"
            className="history-dialog"
            onKeyDown={handleHistoryKeyDown}
            onMouseDown={(event) => event.stopPropagation()}
            ref={historyDialogRef}
            role="dialog"
          >
            <header>
              <div><p className="eyebrow">Document timeline</p><h2>Version history</h2></div>
              <button aria-label="Close version history" className="close-button" onClick={closeHistory} ref={historyCloseRef} type="button">×</button>
            </header>
            <div className="history-content">
              <nav aria-label="Document revisions" className="revision-list">
                {historyLoading && <p className="empty">Loading revisions…</p>}
                {!historyLoading && revisions.length === 0 && <p className="empty">No saved revisions yet.</p>}
                {revisions.map((revision) => (
                  <button
                    className={selectedRevision === revision.revision ? "selected" : ""}
                    key={revision.revision}
                    onClick={() => previewRevision(revision)}
                    type="button"
                  >
                    <strong>Revision {revision.revision}</strong>
                    <span>{new Date(revision.createdAt).toLocaleString()}</span>
                    <small>
                      {revision.operationCount} operations · {revision.actors.length} {revision.actors.length === 1 ? "author" : "authors"}
                    </small>
                  </button>
                ))}
              </nav>
              <div className="version-preview">
                <p className="eyebrow">Read-only preview</p>
                {historyError ? <p className="history-error">{historyError}</p> : <pre>{versionText || "This version is empty."}</pre>}
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
