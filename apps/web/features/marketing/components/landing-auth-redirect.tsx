'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/server-state/query-keys';
import { buildAppHref } from '@/features/navigation/routes';

/** Send signed-in users from the public landing page into the app shell. */
export function LandingAuthRedirect(): ReactNode {
  const router = useRouter();
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: ({ signal }) => getApiClient().auth.session({ signal }),
  });

  useEffect(() => {
    if (session.data?.authenticated === true) {
      router.replace(buildAppHref({ name: 'home' }));
    }
  }, [router, session.data?.authenticated]);

  return null;
}
