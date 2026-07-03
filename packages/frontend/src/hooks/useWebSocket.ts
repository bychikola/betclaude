import { useEffect, useRef, useState, useCallback } from 'react';
import { getAccessToken } from '../lib/api';

export interface WsServerMessage {
  type: 'chunk' | 'done' | 'error' | 'session_created' | 'tool_use' | 'tool_result' | 'heartbeat';
  sessionId: string;
  content?: string;
  message?: string;
  code?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  timestamp?: number;
}

interface UseWebSocketReturn {
  connect: () => void;
  disconnect: () => void;
  send: (msg: { type: string; sessionId?: string; content: string }) => void;
  messages: WsServerMessage[];
  isConnected: boolean;
  currentSessionId: string | null;
  streamingContent: string;
  isStreaming: boolean;
  clearMessages: () => void;
}

export function useWebSocket(): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState<WsServerMessage[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    const token = getAccessToken();
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/chat?token=${token}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsServerMessage = JSON.parse(event.data);

        switch (msg.type) {
          case 'session_created':
            setCurrentSessionId(msg.sessionId);
            break;

          case 'chunk':
            setStreamingContent((prev) => prev + (msg.content || ''));
            setIsStreaming(true);
            break;

          case 'done':
            setIsStreaming(false);
            if (streamingContent) {
              setMessages((prev) => [...prev, {
                type: 'chunk' as const,
                sessionId: msg.sessionId,
                content: streamingContent,
              }]);
            }
            setStreamingContent('');
            break;

          case 'error':
            setMessages((prev) => [...prev, msg]);
            setIsStreaming(false);
            setStreamingContent('');
            break;

          case 'tool_use':
            setMessages((prev) => [...prev, msg]);
            break;

          case 'heartbeat':
            break;

          default:
            setMessages((prev) => [...prev, msg]);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      // Auto-reconnect after 3s
      reconnectTimer.current = setTimeout(() => connect(), 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    setIsConnected(false);
  }, []);

  const send = useCallback((msg: { type: string; sessionId?: string; content: string }) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        ...msg,
        sessionId: msg.sessionId || currentSessionId,
      }));
      setMessages((prev) => [...prev, {
        type: 'chunk' as const,
        sessionId: currentSessionId || '',
        content: msg.content,
      }]);
    }
  }, [currentSessionId]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setStreamingContent('');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return {
    connect, disconnect, send, messages, isConnected,
    currentSessionId, streamingContent, isStreaming, clearMessages,
  };
}
