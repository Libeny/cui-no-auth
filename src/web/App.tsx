import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import InspectorApp from './inspector/InspectorApp';
import ChatApp from './chat/ChatApp';
import Login from './components/Login/Login';
import { useAuth, getAuthToken, setAuthToken } from './hooks/useAuth';

function App() {
  // Handle auth token extraction from URL fragment
  useAuth();

  const [isLoadingAuthStatus, setIsLoadingAuthStatus] = useState(true);
  const [serverAuthSkipped, setServerAuthSkipped] = useState(false);

  // Check server auth status on mount
  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        const response = await fetch('/api/system/auth-status');
        if (response.ok) {
          const data = await response.json();
          if (data.authRequired === false) {
            setServerAuthSkipped(true);
          }
        }
      } catch (error) {
        console.error('Failed to check auth status:', error);
      } finally {
        setIsLoadingAuthStatus(false);
      }
    };
    checkAuthStatus();
  }, []);

  // Check if user is authenticated
  const authToken = getAuthToken();

  // Check if we should skip authentication
  const clientSkipAuth = checkShouldSkipAuth();
  const shouldSkipAuth = clientSkipAuth || serverAuthSkipped;

  if (isLoadingAuthStatus) {
    return <div className="flex items-center justify-center h-screen bg-gray-900 text-white">Loading...</div>;
  }

  // If user has token or auth is skipped, go to main app
  // Otherwise show login screen
  if (!authToken && !shouldSkipAuth) {
    return <Login onLogin={setAuthToken} />;
  }

  return (
    <Router
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <Routes>
        <Route path="/*" element={<ChatApp />} />
        <Route path="/inspector" element={<InspectorApp />} />
      </Routes>
    </Router>
  );
}

/**
 * Check if authentication should be skipped
 * This allows the app to automatically enter without login in certain scenarios
 */
function checkShouldSkipAuth(): boolean {
  // Check if URL has skip-auth parameter
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('skip-auth')) {
    return true;
  }

  // Check if URL has no-auth parameter
  if (urlParams.has('no-auth')) {
    return true;
  }

  // Check if URL path contains /no-auth
  if (window.location.pathname.includes('/no-auth')) {
    return true;
  }

  // Check for development environment with specific flag
  if (process.env.NODE_ENV === 'development' && urlParams.has('dev-no-auth')) {
    return true;
  }

  return false;
}

export default App;