import { useNavigate } from 'react-router';
import { ArrowLeft, LogOut } from 'lucide-react';
import { Button } from '../../components/Button';
import { useAuth } from '../../data/authContext';

/** Temporary stand-in for screens later in the build order. */
export function NotBuiltYet({ title, detail }: { title: string; detail: string }) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  return (
    <div className="notbuilt">
      <h1>{title}</h1>
      <p>{detail}</p>
      <div className="notbuilt-actions">
        <Button icon={<ArrowLeft aria-hidden="true" />} onClick={() => navigate(-1)}>Back</Button>
        {title === 'Settings' && <Button variant="ghost" icon={<LogOut aria-hidden="true" />} onClick={signOut}>Sign out</Button>}
      </div>
    </div>
  );
}
