import React from 'react';
import { useStreamStatus } from '../../contexts/StreamStatusContext';

interface LiveTaskStatusProps {
  streamingId: string;
  fallbackStatus?: string;
}

export const LiveTaskStatus: React.FC<LiveTaskStatusProps> = ({ 
  streamingId, 
  fallbackStatus = 'Running' 
}) => {
  const { getStreamStatus } = useStreamStatus();
  const liveStatus = getStreamStatus(streamingId);

  return (
    <span className={`animate-pulse bg-gradient-to-r from-muted-foreground via-muted-foreground to-muted-foreground/50 bg-[length:200%_100%] bg-clip-text text-transparent ${liveStatus ? 'animate-[shimmer_2s_linear_infinite]' : ''}`}>
      {liveStatus?.currentStatus || fallbackStatus}
    </span>
  );
};
