import { useEffect, useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { LogOut } from 'lucide-react';
import { Button } from '../../components/Button';
import { Wordmark } from '../../components/Wordmark';
import { useAuth } from '../../data/authContext';
import { useApiKeys } from '../../data/library';
import { providerById } from '../../lib/providers';
import { StepWelcome } from './StepWelcome';
import { StepModel } from './StepModel';
import { StepTranscription } from './StepTranscription';
import { StepExtension } from './StepExtension';
import { StepDestinations } from './StepDestinations';
import { StepDone } from './StepDone';
import './wizard.css';

export type StepId = 'welcome' | 'model' | 'transcription' | 'extension' | 'destinations' | 'done';

const ORDER: StepId[] = ['welcome', 'model', 'transcription', 'extension', 'destinations', 'done'];

const LABELS: Record<StepId, string> = {
  welcome: 'Welcome',
  model: 'Your model',
  transcription: 'Transcription',
  extension: 'Chrome extension',
  destinations: 'Destinations',
  done: 'Done',
};

export function Wizard() {
  const { profile, updateOnboarding, signOut } = useAuth();
  const keys = useApiKeys();
  const navigate = useNavigate();
  const params = useParams();

  // The transcription step only appears when the notes provider can't transcribe.
  const notesProvider = providerById(profile?.default_notes_provider);
  const needsTranscription = Boolean(notesProvider && !notesProvider.transcribes);
  const steps = useMemo<StepId[]>(
    () => ['welcome', 'model', ...(needsTranscription ? ['transcription' as const] : []), 'extension', 'destinations', 'done'],
    [needsTranscription],
  );

  // Students can revisit any step they've reached, but not skip ahead.
  const reachedOrder = ORDER.indexOf((profile?.onboarding.step_id as StepId | undefined) ?? 'welcome');
  const reachedIndex = Math.max(0, steps.findLastIndex((s) => ORDER.indexOf(s) <= reachedOrder));
  const requested = params.step as StepId | undefined;
  const current: StepId = requested && steps.includes(requested) && steps.indexOf(requested) <= reachedIndex
    ? requested
    : steps[reachedIndex];
  const index = steps.indexOf(current);

  useEffect(() => {
    if (requested !== current) navigate(`/welcome/${current}`, { replace: true });
  }, [requested, current, navigate]);

  if (profile?.onboarding.completed_at && current !== 'done') return <Navigate to="/" replace />;

  const goTo = async (step: StepId) => {
    if (ORDER.indexOf(step) > reachedOrder) await updateOnboarding({ step_id: step });
    navigate(`/welcome/${step}`);
  };
  const next = async () => goTo(steps[Math.min(index + 1, steps.length - 1)]);
  const back = index > 0 && current !== 'done' ? () => navigate(`/welcome/${steps[index - 1]}`) : undefined;

  const stepProps: StepProps = { next, goTo, back, keys: keys.data ?? [], reloadKeys: keys.reload };

  return (
    <div className="wizard">
      <header className="wizard-top">
        <Wordmark />
        <Button variant="ghost" size="sm" icon={<LogOut aria-hidden="true" />} onClick={signOut}>Sign out</Button>
      </header>

      <nav className="wizard-progress" aria-label="Setup progress">
        <ol>
          {steps.map((s, i) => (
            <li key={s} className={i < index ? 'is-done' : i === index ? 'is-current' : undefined} aria-current={i === index ? 'step' : undefined}>
              <span className="wizard-progress-dot" aria-hidden="true" />
              <span className="wizard-progress-label">{LABELS[s]}</span>
            </li>
          ))}
        </ol>
        <p className="wizard-progress-count tabular" aria-hidden="true">Step {index + 1} of {steps.length} · {LABELS[current]}</p>
      </nav>

      <main className="wizard-main">
        {current === 'welcome' && <StepWelcome {...stepProps} />}
        {current === 'model' && <StepModel {...stepProps} />}
        {current === 'transcription' && <StepTranscription {...stepProps} />}
        {current === 'extension' && <StepExtension {...stepProps} />}
        {current === 'destinations' && <StepDestinations {...stepProps} />}
        {current === 'done' && <StepDone {...stepProps} />}
      </main>
    </div>
  );
}

export interface StepProps {
  next: () => Promise<void>;
  goTo: (step: StepId) => Promise<void>;
  back?: () => void;
  keys: import('../../data/types').ApiKey[];
  reloadKeys: () => Promise<void>;
}
