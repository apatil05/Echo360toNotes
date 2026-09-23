import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import './Message.css';

type Tone = 'info' | 'ok' | 'wait' | 'bad';

const ICONS = { info: Info, ok: CircleCheck, wait: TriangleAlert, bad: CircleAlert };

/** An inline message: icon, text, and an optional action. */
export function Message({ tone = 'info', title, children, action }: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = ICONS[tone];
  return (
    <div className={`message message-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon className="message-icon" aria-hidden="true" />
      <div className="message-body">
        {title && <p className="message-title">{title}</p>}
        {children && <div className="message-text">{children}</div>}
      </div>
      {action && <div className="message-action">{action}</div>}
    </div>
  );
}
