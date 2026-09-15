export const ROOT_ID = "ROOT";

export interface InsertOperation {
  kind: "insert";
  id: string;
  actor: string;
  counter: number;
  after: string;
  value: string;
}

export interface DeleteOperation {
  kind: "delete";
  id: string;
  actor: string;
  counter: number;
  target: string;
}

export type Operation = InsertOperation | DeleteOperation;

export interface DocumentSnapshot {
  operations: Operation[];
}

interface CharacterNode {
  id: string;
  after: string;
  value: string;
  deleted: boolean;
}

const ACTOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function splitGraphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

function operationId(actor: string, counter: number): string {
  return `${actor}:${counter}`;
}

function parseId(id: string): { actor: string; counter: number } {
  const separator = id.lastIndexOf(":");
  if (separator < 1) throw new Error(`invalid operation id: ${id}`);
  const actor = id.slice(0, separator);
  const counter = Number(id.slice(separator + 1));
  if (!ACTOR_PATTERN.test(actor) || !Number.isSafeInteger(counter) || counter < 1) {
    throw new Error(`invalid operation id: ${id}`);
  }
  return { actor, counter };
}

function compareIds(left: string, right: string): number {
  const a = parseId(left);
  const b = parseId(right);
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;
}

function cloneOperation(operation: Operation): Operation {
  return { ...operation };
}

export class SequenceDocument {
  readonly actor: string;
  private counter = 0;
  private readonly nodes = new Map<string, CharacterNode>();
  private readonly pendingDeletes = new Set<string>();
  private readonly operations = new Map<string, Operation>();

  constructor(actor: string) {
    if (!ACTOR_PATTERN.test(actor)) {
      throw new Error("actor must contain 1-64 letters, numbers, underscores, or hyphens");
    }
    this.actor = actor;
  }

  get length(): number {
    return this.visibleNodes().length;
  }

  toString(): string {
    return this.visibleNodes().map((node) => node.value).join("");
  }

  localInsert(index: number, text: string): InsertOperation[] {
    const visible = this.visibleNodes();
    if (!Number.isInteger(index) || index < 0 || index > visible.length) {
      throw new Error("insert index is outside the document");
    }
    const values = splitGraphemes(text);
    if (values.length === 0) return [];

    let after = index === 0 ? ROOT_ID : visible[index - 1].id;
    const created: InsertOperation[] = [];
    for (const value of values) {
      const counter = this.nextCounter();
      const operation: InsertOperation = {
        kind: "insert",
        id: operationId(this.actor, counter),
        actor: this.actor,
        counter,
        after,
        value,
      };
      this.apply(operation);
      created.push(cloneOperation(operation) as InsertOperation);
      after = operation.id;
    }
    return created;
  }

  localDelete(index: number, count = 1): DeleteOperation[] {
    const visible = this.visibleNodes();
    if (!Number.isInteger(index) || index < 0 || index > visible.length) {
      throw new Error("delete index is outside the document");
    }
    if (!Number.isInteger(count) || count < 0) throw new Error("delete count must be non-negative");
    const targets = visible.slice(index, index + count);
    return targets.map((target) => {
      const counter = this.nextCounter();
      const operation: DeleteOperation = {
        kind: "delete",
        id: operationId(this.actor, counter),
        actor: this.actor,
        counter,
        target: target.id,
      };
      this.apply(operation);
      return cloneOperation(operation) as DeleteOperation;
    });
  }

  anchorAt(index: number): string {
    const visible = this.visibleNodes();
    if (!Number.isInteger(index) || index < 0 || index > visible.length) {
      throw new Error("anchor index is outside the document");
    }
    return index === 0 ? ROOT_ID : visible[index - 1].id;
  }

  apply(operation: Operation): boolean {
    this.validate(operation);
    this.counter = Math.max(this.counter, operation.counter);
    const existing = this.operations.get(operation.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(operation)) {
        throw new Error(`conflicting operation payload for ${operation.id}`);
      }
      return false;
    }

    this.operations.set(operation.id, cloneOperation(operation));
    if (operation.kind === "insert") {
      this.nodes.set(operation.id, {
        id: operation.id,
        after: operation.after,
        value: operation.value,
        deleted: this.pendingDeletes.delete(operation.id),
      });
    } else {
      const target = this.nodes.get(operation.target);
      if (target) target.deleted = true;
      else this.pendingDeletes.add(operation.target);
    }
    return true;
  }

  merge(operations: Iterable<Operation>): number {
    let applied = 0;
    for (const operation of operations) {
      if (this.apply(operation)) applied += 1;
    }
    return applied;
  }

  exportOperations(): Operation[] {
    return Array.from(this.operations.values(), cloneOperation)
      .sort((left, right) => compareIds(left.id, right.id));
  }

  snapshot(): DocumentSnapshot {
    return { operations: this.exportOperations() };
  }

  versionVector(): Record<string, number> {
    const vector: Record<string, number> = {};
    for (const operation of this.operations.values()) {
      vector[operation.actor] = Math.max(vector[operation.actor] ?? 0, operation.counter);
    }
    return vector;
  }

  static fromSnapshot(actor: string, snapshot: DocumentSnapshot): SequenceDocument {
    if (!snapshot || !Array.isArray(snapshot.operations)) throw new Error("invalid document snapshot");
    const document = new SequenceDocument(actor);
    document.merge(snapshot.operations);
    return document;
  }

  private nextCounter(): number {
    this.counter += 1;
    return this.counter;
  }

  private validate(operation: Operation): void {
    if (!operation || (operation.kind !== "insert" && operation.kind !== "delete")) {
      throw new Error("unsupported operation");
    }
    if (!ACTOR_PATTERN.test(operation.actor) || !Number.isSafeInteger(operation.counter) || operation.counter < 1) {
      throw new Error("invalid operation actor or counter");
    }
    if (operation.id !== operationId(operation.actor, operation.counter)) {
      throw new Error("operation id does not match actor and counter");
    }
    if (operation.kind === "insert") {
      if (operation.after !== ROOT_ID) parseId(operation.after);
      if (splitGraphemes(operation.value).length !== 1) {
        throw new Error("insert operations must contain exactly one grapheme");
      }
    } else {
      parseId(operation.target);
    }
  }

  private visibleNodes(): CharacterNode[] {
    const children = new Map<string, CharacterNode[]>();
    for (const node of this.nodes.values()) {
      const siblings = children.get(node.after) ?? [];
      siblings.push(node);
      children.set(node.after, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((left, right) => compareIds(right.id, left.id));
    }

    const visible: CharacterNode[] = [];
    const visited = new Set<string>();
    const visit = (parent: string) => {
      for (const node of children.get(parent) ?? []) {
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        if (!node.deleted) visible.push(node);
        visit(node.id);
      }
    };
    visit(ROOT_ID);
    return visible;
  }
}
