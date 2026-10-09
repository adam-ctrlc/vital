import { Badge } from '@/components/ui/badge';

/** Where a reading came from. `hardware` means a real sensor pushed it. */
export function SourceBadge({ source }: { source: string }) {
  switch (source) {
    case 'hardware':
      return <Badge>SENSOR</Badge>;
    case 'simulator':
      return (
        <Badge variant="secondary">
          SIMULATED
        </Badge>
      );
    default:
      return (
        <Badge variant="outline">
          {source.toUpperCase()}
        </Badge>
      );
  }
}
