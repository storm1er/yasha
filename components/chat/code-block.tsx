"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy } from "lucide-react";

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return extractText(props?.children);
  }
  return "";
}

function findCodeElement(
  node: ReactNode
): { className?: string; children?: ReactNode } | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findCodeElement(n);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object" && node !== null && "props" in node) {
    const el = node as { type?: unknown; props?: { className?: string; children?: ReactNode } };
    if (typeof el.type === "string" && el.type === "code") return el.props ?? {};
    return findCodeElement(el.props?.children ?? null);
  }
  return null;
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const t = useTranslations("chat");
  const [copied, setCopied] = useState(false);
  const codeProps = findCodeElement(children);
  const raw = extractText(codeProps?.children ?? children).replace(/\n$/, "");
  const lang = /language-([\w+-]+)/.exec(codeProps?.className ?? "")?.[1] ?? "text";

  async function copy() {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border bg-muted/40">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/60 px-3 py-1 text-xs text-muted-foreground">
        <span className="font-mono lowercase">{lang}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t("copy")}
          data-testid="copy-code"
          className="flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          <span>{copied ? t("copied") : t("copy")}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed">
        <code className="border-0 bg-transparent p-0 font-mono text-inherit">
          {codeProps ? codeProps.children : children}
        </code>
      </pre>
    </div>
  );
}
