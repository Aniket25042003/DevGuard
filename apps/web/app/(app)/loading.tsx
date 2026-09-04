import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/primitives';

export default function Loading(): ReactNode {
  return (
    <div className="space-y-4" role="status" aria-label="Loading workspace">
      <Skeleton className="h-10 w-2/5" />
      <Skeleton className="h-28" />
      <Skeleton className="h-48" />
    </div>
  );
}
