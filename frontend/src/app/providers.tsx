import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type PropsWithChildren } from 'react';
import { PersistenceProvider } from '../state/persistence/PersistenceProvider';

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(
    () => new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          refetchOnWindowFocus: false,
        },
        mutations: { retry: false },
      },
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <PersistenceProvider>{children}</PersistenceProvider>
    </QueryClientProvider>
  );
}
