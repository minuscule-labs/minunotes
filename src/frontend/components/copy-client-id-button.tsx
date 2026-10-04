import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';

export function CopyClientIdButton({ clientId }: { clientId: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => {
    if (status !== 'copied') return;
    const timer = window.setTimeout(() => setStatus('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [status]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(clientId);
      setStatus('copied');
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="mt-2">
      <Button onClick={copy} aria-label="Copy client ID" className="inline-flex items-center gap-2">
        {status === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {status === 'copied' ? 'Copied' : 'Copy client ID'}
      </Button>
      <p role="status" className="mt-1 text-xs">
        {status === 'copied'
          ? 'Client ID copied.'
          : status === 'error'
            ? 'Unable to copy. Select and copy the client ID above.'
            : ''}
      </p>
    </div>
  );
}
