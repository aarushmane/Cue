// Tiny, safe renderer for agent reports: headings (#), bullets (* / -), **bold** and `code`. No HTML is
// interpreted; everything else is plain text.
import type { ReactNode } from "react";

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="rounded bg-tint px-1 text-[0.92em]">{part.slice(1, -1)}</code>
    ) : (
      part
    ),
  );
}

export function MiniMarkdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`ul${out.length}`} className="m-0 flex flex-col gap-1 pl-5">{list}</ul>);
    list = [];
  };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const bullet = /^[*-]\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(<li key={i}>{inline(bullet[1])}</li>);
      return;
    }
    flush();
    if (!line) return;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) out.push(<h3 key={i} className="m-0 mt-1 text-base font-bold text-indigo">{inline(h[1])}</h3>);
    else out.push(<p key={i} className="m-0">{inline(line)}</p>);
  });
  flush();
  return <div className="flex flex-col gap-2 text-[15px]">{out}</div>;
}
