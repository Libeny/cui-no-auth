import React, { useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/web/chat/components/ui/button';
import { Input } from '@/web/chat/components/ui/input';

interface LoginProps {
  onLogin: (token: string) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Support any token input - empty token or custom token
    // Allow both empty string (no auth) and custom tokens
    if (token.length === 0) {
      // Allow empty token for no-auth mode
      setError('');
      onTokenSubmit('');
      return;
    }

    // For non-empty tokens, allow any string
    setError('');
    onTokenSubmit(token);

  };

  const onTokenSubmit = (tokenValue: string) => {
    onLogin(tokenValue);
    // Clear the fragment and refresh page
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-white dark:bg-neutral-900 p-6">
      <div className="w-full max-w-[400px] px-8 py-12 bg-white dark:bg-neutral-800 dark:shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
        <h2 className="text-lg font-normal mb-2 text-neutral-900 dark:text-neutral-100 text-center tracking-tight">
          Access token:
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 text-center mb-4">
          Enter any token, or leave empty for no authentication
        </p>
        
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex gap-2 items-center">
            <Input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter any token or leave empty"
              className="flex-1 h-11 px-4 rounded-3xl bg-neutral-50 dark:bg-neutral-700 border-neutral-200 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 font-mono text-sm transition-all focus:bg-white dark:focus:bg-neutral-900 focus:border-neutral-400 dark:focus:border-neutral-500"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-label="Access token input"
            />
            
            <Button
              type="submit"
              size="icon"
              className="w-11 h-11 rounded-full bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200 hover:-translate-y-px hover:shadow-[0_2px_8px_rgba(0,0,0,0.15)] active:translate-y-0 transition-all"
              aria-label="Submit access token"
            >
              <ArrowUp size={16} />
            </Button>
          </div>
          
          {error && (
            <div className="text-[13px] text-red-500 text-center -mt-2">
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}