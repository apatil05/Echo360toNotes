import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { CircleCheck, Upload } from 'lucide-react';
import { Button } from '../../components/Button';
import { useAuth } from '../../data/authContext';
import { APP_NAME } from '../../lib/brand';
import { providerById } from '../../lib/providers';
import type { StepProps } from './Wizard';

export function StepDone({ keys }: StepProps) {
  const { profile, updateOnboarding } = useAuth();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState<string | null>(null);
  const onboarding = profile?.onboarding;
  const provider = providerById(profile?.default_notes_provider);
  const canTranscribe = keys.some((k) => providerById(k.provider)?.transcribes);

  useEffect(() => {
    if (onboarding && !onboarding.completed_at) void updateOnboarding({ completed_at: new Date().toISOString() });
  }, [onboarding, updateOnboarding]);

  const go = (to: string) => {
    setLeaving(to);
    navigate(to, { replace: true });
  };

  return (
    <section className="step">
      <span className="step-icon step-icon-ok"><CircleCheck aria-hidden="true" /></span>
      <div className="step-head">
        <h1>You’re all set</h1>
        <p>
          {onboarding?.capture === 'extension'
            ? <>Open a lecture on Echo360, press play for a moment, then use <strong>Send to {APP_NAME}</strong> in the extension.</>
            : <>Upload a lecture recording or transcript to make your first notes.</>}
        </p>
      </div>

      <dl className="summary">
        <div>
          <dt>Notes model</dt>
          <dd>{provider?.label ?? 'Not set'}{profile?.default_notes_model ? <span className="mono"> · {profile.default_notes_model}</span> : null}</dd>
        </div>
        <div>
          <dt>Lectures without captions</dt>
          <dd>{canTranscribe ? 'Ready' : 'Add a transcription key in Settings'}</dd>
        </div>
        <div>
          <dt>Capture</dt>
          <dd>{onboarding?.capture === 'extension' ? 'Chrome extension linked' : 'Uploads only'}</dd>
        </div>
      </dl>

      <div className="step-actions">
        <Button variant="ghost" size="lg" icon={<Upload aria-hidden="true" />} onClick={() => go('/new')} loading={leaving === '/new'}>
          Upload a lecture
        </Button>
        <Button variant="primary" size="lg" onClick={() => go('/')} loading={leaving === '/'}>Go to your library</Button>
      </div>
    </section>
  );
}
