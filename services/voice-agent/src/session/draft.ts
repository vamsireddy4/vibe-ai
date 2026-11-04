/**
 * Thinking while the caller talks: a draft reply is generated from the live (partial) transcript, silently.
 * When the final transcript says the same thing, the draft is spoken at once (no model wait); otherwise it
 * is thrown away and the reply is made normally. Drafts never speak on their own.
 */

const words = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/**
 * Does the final transcript ask the same thing as the draft's text? Final text is post-processed
 * (punctuation, "two" -> "2"), so compare words loosely: at least 80% shared, and never more words than the draft heard.
 */
export function sameRequest(draftText: string, finalText: string): boolean {
  const a = words(draftText);
  const b = words(finalText);
  if (!a.length || !b.length) return false;
  if (b.length > a.length) return false; // the caller said more after the draft started
  const pool = [...a];
  let shared = 0;
  for (const w of b) {
    const i = pool.indexOf(w);
    if (i >= 0) { shared++; pool.splice(i, 1); }
  }
  return shared / Math.max(a.length, b.length) >= 0.8;
}

/** A reply being generated in the background. Its tokens are kept so the turn can replay them from the start. */
export class Draft {
  private tokens: string[] = [];
  private done = false;
  private failed: unknown = null;
  private wake: (() => void) | null = null;
  readonly controller = new AbortController();

  constructor(readonly text: string, source: (signal: AbortSignal) => AsyncIterable<string>) {
    void (async () => {
      try {
        for await (const t of source(this.controller.signal)) {
          this.tokens.push(t);
          this.wake?.();
        }
      } catch (e) {
        this.failed = e;
      } finally {
        this.done = true;
        this.wake?.();
      }
    })();
  }

  abort() {
    this.controller.abort();
  }

  /** Every token so far, then the rest as it arrives. Throws if the draft failed (or was aborted). */
  async *replay(): AsyncGenerator<string> {
    for (let i = 0; ; i++) {
      while (i >= this.tokens.length && !this.done) await new Promise<void>((r) => (this.wake = r));
      if (i < this.tokens.length) { yield this.tokens[i]; continue; }
      if (this.failed) throw this.failed;
      return;
    }
  }
}
