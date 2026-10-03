import { createElement } from 'react';
import { Alert } from 'react-native';
import { registerRootComponent } from 'expo';

import App from './App';
import ErrorBoundary from './src/ErrorBoundary';

// Di build release, error JS yang tidak tertangkap langsung force close tanpa pesan.
// Untuk prototipe uji, tampilkan pesannya supaya bisa dilaporkan.
const defaultHandler = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error, isFatal) => {
  Alert.alert(isFatal ? 'Error (fatal)' : 'Error', `${error?.name}: ${error?.message}\n\n${String(error?.stack ?? '').slice(0, 800)}`);
  if (!isFatal) defaultHandler(error, isFatal);
});

registerRootComponent(() => createElement(ErrorBoundary, null, createElement(App)));
