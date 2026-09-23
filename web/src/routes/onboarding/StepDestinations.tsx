import { useState } from 'react';
import { FolderDown, HardDrive, NotebookPen } from 'lucide-react';
import { Button } from '../../components/Button';
import { APP_NAME } from '../../lib/brand';
import type { StepProps } from './Wizard';

const DESTINATIONS = [
  {
    id: 'google_drive',
    name: 'Google Drive',
    Icon: HardDrive,
    detail: 'New notes are saved to a Drive folder you pick. We can only see files we create.',
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    Icon: NotebookPen,
    detail: `Install the ${APP_NAME} plugin in Obsidian and sign in there; notes arrive in your vault.`,
  },
];

export function StepDestinations({ next, back }: StepProps) {
  const [continuing, setContinuing] = useState(false);
  const go = async () => {
    setContinuing(true);
    await next();
  };

  return (
    <section className="step">
      <div className="step-head">
        <h1>Send notes anywhere else?</h1>
        <p>Optional. Every note is always saved in {APP_NAME}; these copy it somewhere you already study.</p>
      </div>

      <ul className="destinations">
        {DESTINATIONS.map(({ id, name, Icon, detail }) => (
          <li key={id} className="destination">
            <Icon className="destination-icon" aria-hidden="true" />
            <span className="destination-text">
              <strong>{name}</strong>
              <span>{detail}</span>
            </span>
            <span className="destination-soon">Coming soon</span>
          </li>
        ))}
        <li className="destination">
          <FolderDown className="destination-icon" aria-hidden="true" />
          <span className="destination-text">
            <strong>Download a folder</strong>
            <span>Export any course as Obsidian-ready markdown files, whenever you like.</span>
          </span>
          <span className="destination-ready">Always on</span>
        </li>
      </ul>

      <div className="step-actions">
        {back && <Button variant="ghost" size="lg" onClick={back}>Back</Button>}
        <Button variant="primary" size="lg" onClick={go} loading={continuing}>Continue</Button>
      </div>
    </section>
  );
}
