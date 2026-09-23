import { useMemo, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CircleAlert, Info, Lightbulb, Star, TriangleAlert } from 'lucide-react';
import { sectionId } from '../lib/sections';
import './NoteBody.css';

/**
 * Renders the notes' Obsidian-flavoured markdown. Raw HTML is never rendered
 * (react-markdown ignores it), because the text comes from a model reading a
 * lecture we don't control.
 */

// Markdown renders the generator's "*(MOST IMPORTANT)*" as emphasis, so the
// asterisks are gone by the time we read the heading text.
const MOST_IMPORTANT = /\s*\*?\(\s*MOST IMPORTANT\s*\)\*?\s*$/i;

const CALLOUTS = {
  important: { Icon: Star, label: 'Important' },
  warning: { Icon: TriangleAlert, label: 'Exam warning' },
  note: { Icon: Info, label: 'Definition' },
  tip: { Icon: Lightbulb, label: 'Tip' },
  caution: { Icon: CircleAlert, label: 'Careful' },
} as const;

type CalloutKind = keyof typeof CALLOUTS;

/** Splits "> [!tip] Title" off the front of a blockquote. */
function readCallout(children: ReactNode): { kind: CalloutKind; body: ReactNode } | null {
  const nodes = Array.isArray(children) ? children : [children];
  const firstText = findFirstText(nodes);
  const match = firstText?.match(/^\s*\[!(\w+)\]\s*/);
  if (!match) return null;
  const kind = match[1].toLowerCase() as CalloutKind;
  if (!(kind in CALLOUTS)) return null;
  return { kind, body: stripMarker(nodes, match[0]) };
}

function findFirstText(nodes: ReactNode[]): string | undefined {
  for (const node of nodes) {
    if (typeof node === 'string' && node.trim()) return node;
    if (node && typeof node === 'object' && 'props' in node) {
      const inner = (node as { props?: { children?: ReactNode } }).props?.children;
      const found = findFirstText(Array.isArray(inner) ? inner : [inner]);
      if (found) return found;
    }
  }
  return undefined;
}

/** Removes the "[!tip]" marker from the first text node it appears in. */
function stripMarker(nodes: ReactNode[], marker: string): ReactNode {
  let done = false;
  const walk = (node: ReactNode): ReactNode => {
    if (done) return node;
    if (typeof node === 'string') {
      if (!node.includes(marker.trim())) return node;
      done = true;
      return node.replace(marker, '').replace(/^\s*\n/, '');
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object' && 'props' in node) {
      const el = node as React.ReactElement<{ children?: ReactNode }>;
      const inner = el.props.children;
      if (inner === undefined) return node;
      const next = Array.isArray(inner) ? inner.map(walk) : walk(inner);
      return { ...el, props: { ...el.props, children: next } } as ReactNode;
    }
    return node;
  };
  return nodes.map(walk);
}

/** All the text inside a node, including emphasis and links. */
function plainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return plainText((node as React.ReactElement<{ children?: ReactNode }>).props.children);
  }
  return '';
}

function Heading({ level, children }: { level: 2 | 3; children: ReactNode }) {
  // The generator marks a section with "*(MOST IMPORTANT)*", which markdown
  // renders as emphasis; show it as a badge instead.
  const text = plainText(children);
  const flagged = MOST_IMPORTANT.test(text);
  const clean = text.replace(MOST_IMPORTANT, '').trim();
  const Tag = level === 2 ? 'h2' : 'h3';
  return (
    <Tag id={level === 2 ? sectionId(clean) : undefined} className={flagged ? 'note-heading is-key' : 'note-heading'}>
      {clean || children}
      {flagged && <span className="note-key">Most important</span>}
    </Tag>
  );
}

export function NoteBody({ markdown }: { markdown: string }) {
  // The generator writes YAML frontmatter for Obsidian; the reader shows the notes.
  const body = useMemo(() => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '').replace(/^#\s[^\n]*\n+/, ''), [markdown]);

  const components: Components = {
    h1: ({ children }) => <Heading level={2}>{children}</Heading>,
    h2: ({ children }) => <Heading level={2}>{children}</Heading>,
    h3: ({ children }) => <Heading level={3}>{children}</Heading>,
    blockquote: ({ children }) => {
      const callout = readCallout(children);
      if (!callout) return <blockquote className="note-quote">{children}</blockquote>;
      const { Icon, label } = CALLOUTS[callout.kind];
      return (
        <aside className={`callout callout-${callout.kind}`}>
          <Icon className="callout-icon" aria-hidden="true" />
          <span className="visually-hidden">{label}:</span>
          <div className="callout-body">{callout.body}</div>
        </aside>
      );
    },
    table: ({ children }) => <div className="note-table"><table>{children}</table></div>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
  };

  return (
    <div className="note-body">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>{body}</Markdown>
    </div>
  );
}
