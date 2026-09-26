import { useEffect, useRef, useState } from 'react';
import { api, post } from './api';

type GoogleResponse = { credential: string };
type GoogleClient = {
  accounts: { id: {
    initialize(options: { client_id: string; nonce: string; callback: (response: GoogleResponse) => void }): void;
    renderButton(element: HTMLElement, options: { theme: string; size: string; text: string; width: number }): void;
  } };
};
declare global { interface Window { google?: GoogleClient } }

let loading: Promise<void> | null = null;
function loadGoogle() {
  if (window.google) return Promise.resolve();
  if (!loading) loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { loading = null; reject(new Error('Google sign-in could not load')); };
    document.head.appendChild(script);
  });
  return loading;
}

export function GoogleSignIn({ mode, onSuccess, onError }: {
  mode: 'login' | 'link'; onSuccess: () => void; onError: (message: string) => void;
}) {
  const button = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSuccess, onError });
  callbacks.current = { onSuccess, onError };
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    api<{ enabled: boolean; clientId?: string; nonce?: string }>('/auth/google/config')
      .then(async config => {
        if (!config.enabled || !config.clientId || !config.nonce) return;
        await loadGoogle();
        if (!active || !button.current || !window.google) return;
        setEnabled(true);
        window.google.accounts.id.initialize({
          client_id: config.clientId,
          nonce: config.nonce,
          callback: async response => {
            if (!active) return;
            try {
              await post(mode === 'link' ? '/auth/google/link' : '/auth/google', { credential: response.credential });
              if (mode === 'link') { setEnabled(false); button.current?.replaceChildren(); }
              callbacks.current.onSuccess();
            } catch (cause) { callbacks.current.onError((cause as Error).message); }
          },
        });
        button.current.replaceChildren();
        window.google.accounts.id.renderButton(button.current, {
          theme: 'outline', size: 'large', text: mode === 'link' ? 'continue_with' : 'signin_with', width: 250,
        });
      })
      .catch(cause => { if (active) callbacks.current.onError((cause as Error).message); });
    return () => { active = false; };
  }, [mode]);

  return <div className={`google-signin${enabled ? ' google-signin-ready' : ''}`}>
    {mode === 'link' && <small>Link Google to this CrewYard account</small>}
    <div ref={button} />
  </div>;
}
