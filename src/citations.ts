import type { Doc, StepEvent } from "./providers/types.js";

/**
 * For models without a native citation API, tool results label each doc with
 * an id ("[S3] Title …") and the model cites by writing "[S3]" or "[S3, S5]".
 * This parser pulls those markers out of the token stream as they arrive —
 * markers can be split across chunks, so a possible marker is held back until
 * it either closes or clearly isn't one.
 */
const COMPLETE = /^\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\]/;
const PARTIAL = /^\[\s*(S\d*(\s*[,;]\s*S?\d*)*)?\s*$/;

export class MarkerParser {
  private buf = "";

  push(text: string): StepEvent[] {
    this.buf += text;
    const out: StepEvent[] = [];
    for (;;) {
      const i = this.buf.indexOf("[");
      if (i < 0) {
        if (this.buf) out.push({ type: "text", text: this.buf });
        this.buf = "";
        return out;
      }
      if (i > 0) out.push({ type: "text", text: this.buf.slice(0, i) });
      const rest = this.buf.slice(i);
      const m = COMPLETE.exec(rest);
      if (m) {
        out.push({ type: "cite", refs: m[1]!.split(/\s*[,;]\s*/) });
        this.buf = rest.slice(m[0].length);
        continue;
      }
      if (PARTIAL.test(rest) && rest.length < 48) {
        this.buf = rest; // wait for more tokens
        return out;
      }
      out.push({ type: "text", text: "[" });
      this.buf = rest.slice(1);
    }
  }

  flush(): StepEvent[] {
    const t = this.buf;
    this.buf = "";
    return t ? [{ type: "text", text: t }] : [];
  }
}

/** Render docs as plain text for marker-citing models. */
export function docsAsText(header: string, docs: Doc[]): string {
  const body = docs.map((d) => {
    const where = d.source.startsWith("memory://") ? "earlier conversation with this user (memory)" : d.source;
    return `[${d.id}] ${d.title}\nSource: ${where}\n${d.content.join("\n")}`;
  });
  return [header, ...body].join("\n\n");
}
