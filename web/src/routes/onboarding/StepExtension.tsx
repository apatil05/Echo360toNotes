import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, Link2, Play, PuzzleIcon, RefreshCw } from 'lucide-react';
import { Button } from '../../components/Button';
import { Message } from '../../components/Message';
import { useAuth } from '../../data/authContext';
import { APP_NAME } from '../../lib/brand';
import {
  browserLabel, browserSupport, EXTENSION_STORE_URL, MIN_EXTENSION_VERSION, pingExtension, sendLinkCode,
  type ExtensionStatus,
} from '../../lib/extension';
import { functionsUrl, supabase } from '../../lib/supabase';
import type { StepProps } from './Wizard';

type LinkState =
  | { phase: 'idle' }
  | { phase: 'linking' }
  | { phase: 'failed'; message: string };

const POLL_MS = 2000;

export function StepExtension({ next, back }: StepProps) {
  const { session, updateOnboarding } = useAuth();
  const support = browserSupport();
  const [status, setStatus] = useState<ExtensionStatus | null>(null);
  const [link, setLink] = useState<LinkState>({ phase: 'idle' });
  const [continuing, setContinuing] = useState(false);
  const userId = session?.user.id ?? '';
  const email = session?.user.email ?? 'your account';

  const check = useCallback(async () => setStatus(await pingExtension()), []);

  // Watch for the extension being installed or linked, without a refresh.
  const linking = link.phase === 'linking';
  const linked = Boolean(status?.installed && status.linkedUserId === userId);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => {
    if (support !== 'chromium-desktop') return;
    // Polls the extension (an external system); state updates land asynchronously.
    // oxlint-disable-next-line react/set-state-in-effect
    void check();
    if (linked || linking) return;
    pollRef.current = setInterval(check, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [support, check, linked, linking]);

  const finish = async (capture: 'extension' | 'upload-only') => {
    setContinuing(true);
    try {
      await updateOnboarding({ capture });
      await next();
    } finally {
      setContinuing(false);
    }
  };

  const linkBrowser = async () => {
    if (!session) return;
    setLink({ phase: 'linking' });
    try {
      const res = await fetch(`${functionsUrl}/link-extension`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Couldn't create a link code (HTTP ${res.status}).`);
      const result = await sendLinkCode(body.tokenHash, userId);
      if (!result.ok) throw new Error(result.error ?? 'The extension couldn’t finish linking.');
      await check();
      setLink({ phase: 'idle' });
    } catch (err) {
      setLink({ phase: 'failed', message: (err as Error).message });
      // A stale session can make the code request fail; refresh for the retry.
      void supabase.auth.refreshSession();
    }
  };

  if (support !== 'chromium-desktop') {
    return (
      <section className="step">
        <LectureMock state="unsupported" />
        <div className="step-head">
          <h1>Capturing from Echo360 needs Chrome</h1>
          <p>
            The extension that captures lectures runs in Chrome on a computer (Edge, Brave and Arc work too).
            You can still use {APP_NAME} here with lectures you already have: upload a recording or a transcript.
          </p>
        </div>
        <Message tone="info">
          To capture straight from Echo360 later, open {APP_NAME} in Chrome on a computer and link it from Settings.
        </Message>
        <div className="step-actions">
          {back && <Button variant="ghost" size="lg" onClick={back}>Back</Button>}
          <Button variant="primary" size="lg" loading={continuing} onClick={() => finish('upload-only')}>
            Continue with uploads
          </Button>
        </div>
      </section>
    );
  }

  const uploadsOnly = (
    <Button variant="ghost" size="lg" onClick={() => finish('upload-only')} disabled={continuing}>
      Use uploads only
    </Button>
  );

  // Linked
  if (linked) {
    return (
      <section className="step">
        <LectureMock state="linked" />
        <div className="step-head">
          <h1>This browser is linked</h1>
          <p>Open a lecture on Echo360 and use the extension’s <strong>Send to {APP_NAME}</strong> button.</p>
        </div>
        <div className="linked-browser">
          <PuzzleIcon aria-hidden="true" />
          <span>
            <strong>{browserLabel()}</strong>
            <span className="linked-browser-meta">Linked to {email}{status?.version ? ` · extension ${status.version}` : ''}</span>
          </span>
        </div>
        <div className="step-actions">
          {back && <Button variant="ghost" size="lg" onClick={back}>Back</Button>}
          <Button variant="primary" size="lg" loading={continuing} onClick={() => finish('extension')}>Continue</Button>
        </div>
      </section>
    );
  }

  // Installed but needs an update
  if (status?.installed && status.outdated) {
    return (
      <section className="step">
        <LectureMock state="update" />
        <div className="step-head">
          <h1>Update the extension</h1>
          <p>
            You have version {status.version ?? 'unknown'}; linking needs {MIN_EXTENSION_VERSION} or newer.
            Chrome updates extensions on its own, or you can update it from <span className="mono">chrome://extensions</span>.
          </p>
        </div>
        <div className="step-actions">
          {back && <Button variant="ghost" size="lg" onClick={back}>Back</Button>}
          {uploadsOnly}
          <Button variant="primary" size="lg" icon={<RefreshCw aria-hidden="true" />} onClick={check}>Check again</Button>
        </div>
      </section>
    );
  }

  // Installed, not linked to this account (or to another one)
  if (status?.installed) {
    const other = Boolean(status.linkedUserId);
    return (
      <section className="step">
        <LectureMock state="link" />
        <div className="step-head">
          <h1>{other ? 'This browser is linked to another account' : 'Link this browser'}</h1>
          <p>
            {other
              ? <>Linking it to <strong>{email}</strong> signs the extension out of the other account.</>
              : <>The extension will send lectures to <strong>{email}</strong>. You won’t need to sign in inside the extension.</>}
          </p>
        </div>
        {link.phase === 'failed' && (
          <Message tone="bad" title="Linking didn’t finish">{link.message} Try again.</Message>
        )}
        <div className="step-actions">
          {back && <Button variant="ghost" size="lg" onClick={back}>Back</Button>}
          {uploadsOnly}
          <Button variant="primary" size="lg" icon={<Link2 aria-hidden="true" />} loading={linking} onClick={linkBrowser}>
            {other ? 'Switch to this account' : link.phase === 'failed' ? 'Try again' : 'Link this browser'}
          </Button>
        </div>
      </section>
    );
  }

  // Not installed (or still checking)
  return (
    <section className="step">
      <LectureMock state="install" />
      <div className="step-head">
        <h1>Add the Chrome extension</h1>
        <p>
          It adds a <strong>Send to {APP_NAME}</strong> button to Echo360 lecture pages and captures the lecture
          with the login you already use. It can only talk to {APP_NAME}.
        </p>
      </div>

      <div className="extension-install">
        {EXTENSION_STORE_URL ? (
          <a className="btn btn-primary btn-lg" href={EXTENSION_STORE_URL} target="_blank" rel="noreferrer">
            <Download aria-hidden="true" /><span className="btn-label">Add to Chrome</span>
          </a>
        ) : (
          <Message tone="wait" title="The extension isn’t in the Chrome Web Store yet">
            For now, load it from the project’s <span className="mono">extension</span> folder at <span className="mono">chrome://extensions</span> (Developer mode, then Load unpacked).
          </Message>
        )}
        <p className="waiting" aria-live="polite">
          <span className="waiting-dot" aria-hidden="true" />
          {status ? 'Waiting for the extension… this page updates on its own.' : 'Checking for the extension…'}
        </p>
      </div>

      <div className="step-actions">
        {back && <Button variant="ghost" size="lg" onClick={back}>Back</Button>}
        {uploadsOnly}
      </div>
    </section>
  );
}

type MockState = 'install' | 'link' | 'linked' | 'update' | 'unsupported';

const MOCK_BUTTON: Record<MockState, { label: string; Icon: typeof Check }> = {
  install: { label: 'Extension not added', Icon: PuzzleIcon },
  link: { label: 'Link to use', Icon: Link2 },
  linked: { label: `Send to ${APP_NAME}`, Icon: Check },
  update: { label: 'Update needed', Icon: RefreshCw },
  unsupported: { label: 'Needs Chrome on a computer', Icon: PuzzleIcon },
};

/** What the student will see on their lecture page, in this step's state. */
function LectureMock({ state }: { state: MockState }) {
  const { label, Icon } = MOCK_BUTTON[state];
  return (
    <div className="lecture-mock" aria-hidden="true">
      <div className="lecture-mock-bar">
        <i /><i /><i />
        <span>Your lecture page</span>
      </div>
      <div className="lecture-mock-body">
        <span className="lecture-mock-player"><Play /></span>
        <span className="lecture-mock-text">
          <strong>Week 3 · Lecture 2</strong>
          <span className="tabular">1:14:52</span>
        </span>
        <span className={`lecture-mock-send is-${state}`}><Icon />{label}</span>
      </div>
    </div>
  );
}
