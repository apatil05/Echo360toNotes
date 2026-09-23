// Each course stores its cover colour (assigned by the database so a student's
// courses stay distinct). This maps it to the theme's cover tokens.
import type { CoverColor } from '../data/types';

export function coverStyle(color: CoverColor): React.CSSProperties {
  const c = color;
  return {
    '--cover': `var(--cover-${c})`,
    '--cover-ink': `var(--cover-${c}-ink)`,
  } as React.CSSProperties;
}
