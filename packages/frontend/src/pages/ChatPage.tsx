import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useWebSocket, type WsServerMessage } from '../hooks/useWebSocket';
import { matches as matchesApi } from '../lib/api';
import {
  Send, MessageCircle, Home, History, LogOut, Activity,
  Wifi, WifiOff, AlertCircle, Zap
} from 'lucide-react';
import toast from 'react-hot-toast';

export function ChatPage() {
  const { user, logout } = useAuth();
  const [searchParams] = useSearchParams();
  const matchId = searchParams.get('match');
  const {
    connect, disconnect, send, messages, isConnected,
    currentSessionId, streamingContent, isStreaming, clearMessages,
  } = useWebSocket();
  const [input, setInput] = useState('');
  const [matchInfo, setMatchInfo] = useState<any>(null);
  const [liveMatches, setLiveMatches] = useState<any[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Connect on mount
  useEffect(() => {
    connect();
    return () => disconnect();
  }, []);

  // Fetch match info and live matches
  useEffect(() => {
    if (matchId) {
      matchesApi.get(matchId).then((data: any) => setMatchInfo(data.match)).catch(() => {});
    }
    matchesApi.list({ status: 'live' }).then((data: any) => {
      setLiveMatches((data.matches || []).slice(0, 10));
    }).catch(() => {});
  }, [matchId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleSend = () => {
    if (!input.trim() || !isConnected) return;
    send({ type: 'message', content: input });
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleMatchClick = (match: any) => {
    const prompt = `Analyze the match: ${match.home_team} vs ${match.away_team}. Current score: ${match.home_score}-${match.away_score} (${match.minute}'). Give me a detailed live analysis.`;
    send({ type: 'message', content: prompt });
  };

  return (
    <div className="h-screen flex bg-gray-950">
      {/* Sidebar */}
      <aside className="w-64 border-r border-gray-800 bg-gray-900/50 flex flex-col hidden lg:flex">
        <div className="p-4 border-b border-gray-800">
          <Link to="/" className="text-lg font-bold">
            <span className="text-blue-500">Bet</span><span className="text-white">Claude</span>
          </Link>
        </div>

        <div className="p-3 border-b border-gray-800">
          <div className={`flex items-center gap-2 text-xs ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
            {isConnected ? <Wifi size={12} /> : <WifiOff size={12} />}
            {isConnected ? 'Connected' : 'Disconnected'}
          </div>
          {currentSessionId && (
            <div className="text-xs text-gray-600 mt-1 truncate">Session: {currentSessionId.slice(0, 12)}...</div>
          )}
        </div>

        {/* Live matches sidebar */}
        <div className="flex-1 overflow-y-auto p-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1.5">
            <Activity size={12} className="text-green-400" /> Live Now
          </h3>
          {liveMatches.map((m: any) => (
            <button
              key={m.id}
              onClick={() => handleMatchClick(m)}
              className="w-full text-left p-2 rounded-lg hover:bg-gray-800 mb-1 transition-colors"
            >
              <div className="text-xs text-gray-500 truncate">{m.league_name}</div>
              <div className="text-sm flex justify-between">
                <span className="truncate">{m.home_short || m.home_team}</span>
                <span className="font-bold mx-2 text-green-400">{m.home_score}-{m.away_score}</span>
                <span className="truncate text-right">{m.away_short || m.away_team}</span>
              </div>
              <div className="text-xs text-gray-600">{m.minute}'</div>
            </button>
          ))}
        </div>

        {/* Nav */}
        <div className="p-3 border-t border-gray-800 space-y-1">
          <Link to="/" className="flex items-center gap-2 text-sm text-gray-400 hover:text-white py-2 px-2 rounded-lg hover:bg-gray-800 transition-colors">
            <Home size={16} /> Dashboard
          </Link>
          <Link to="/sessions" className="flex items-center gap-2 text-sm text-gray-400 hover:text-white py-2 px-2 rounded-lg hover:bg-gray-800 transition-colors">
            <History size={16} /> History
          </Link>
          <button onClick={() => { clearMessages(); toast.success('Chat cleared'); }}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white py-2 px-2 rounded-lg hover:bg-gray-800 transition-colors w-full">
            <AlertCircle size={16} /> Clear Chat
          </button>
          <button onClick={logout} className="flex items-center gap-2 text-sm text-gray-400 hover:text-red-400 py-2 px-2 rounded-lg hover:bg-gray-800 transition-colors w-full">
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </aside>

      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <header className="h-14 border-b border-gray-800 flex items-center px-4 gap-4">
          <Link to="/" className="lg:hidden text-blue-500 font-bold">BC</Link>
          <div className="flex-1">
            {matchInfo ? (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{matchInfo.home_team} vs {matchInfo.away_team}</span>
                <span className="text-xs text-gray-500">{matchInfo.league_name}</span>
                {matchInfo.status === 'live' && (
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                    {matchInfo.home_score}-{matchInfo.away_score} ({matchInfo.minute}')
                  </span>
                )}
              </div>
            ) : (
              <span className="text-sm text-gray-400 flex items-center gap-2">
                <MessageCircle size={16} /> New Analysis
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>{user?.username}</span>
            <span className="px-2 py-0.5 rounded bg-gray-800 capitalize">{user?.subscription}</span>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6">
          {messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 rounded-2xl bg-blue-600/20 flex items-center justify-center mb-4">
                <Zap size={28} className="text-blue-400" />
              </div>
              <h2 className="text-xl font-semibold mb-2">BetClaude Analysis</h2>
              <p className="text-gray-500 max-w-md mb-4">
                Ask me about any match, team, or league. I analyze live data, historical stats, and odds to give you insights.
              </p>
              <div className="flex flex-wrap gap-2 justify-center">
                {['Analyze upcoming Real Madrid vs Barcelona', 'What are the best odds for today?', 'Show me live Premier League scores', 'Compare Man City and Arsenal form'].map(prompt => (
                  <button key={prompt} onClick={() => { setInput(prompt); }}
                    className="text-xs text-gray-400 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-full transition-colors">
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="max-w-3xl mx-auto space-y-4">
            {messages.map((msg, i) => (
              <ChatBubble key={i} msg={msg} />
            ))}

            {/* Streaming message */}
            {isStreaming && streamingContent && (
              <div className="message-enter flex gap-3">
                <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Zap size={14} className="text-white" />
                </div>
                <div className="bg-gray-800/50 rounded-xl px-4 py-3 text-sm leading-relaxed streaming-cursor max-w-full">
                  <div className="whitespace-pre-wrap">{streamingContent}</div>
                </div>
              </div>
            )}

            {isStreaming && !streamingContent && (
              <div className="flex gap-3">
                <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0">
                  <Zap size={14} className="text-white" />
                </div>
                <div className="flex gap-1.5 py-2">
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className="border-t border-gray-800 p-4">
          <div className="max-w-3xl mx-auto flex gap-3">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isConnected ? 'Ask about any match, team, or league...' : 'Reconnecting...'}
              disabled={!isConnected}
              rows={1}
              className="input-field resize-none flex-1"
            />
            <button
              onClick={handleSend}
              disabled={!isConnected || !input.trim()}
              className="btn-primary flex items-center gap-2 flex-shrink-0"
            >
              <Send size={16} />
            </button>
          </div>
          <div className="max-w-3xl mx-auto mt-2 text-xs text-gray-600">
            Press Enter to send, Shift+Enter for new line
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ msg }: { msg: WsServerMessage }) {
  if (msg.type === 'error') {
    return (
      <div className="message-enter flex gap-3">
        <div className="w-7 h-7 rounded-lg bg-red-600/20 flex items-center justify-center flex-shrink-0">
          <AlertCircle size={14} className="text-red-400" />
        </div>
        <div className="bg-red-900/20 border border-red-800/50 rounded-xl px-4 py-3 text-sm text-red-300">
          {msg.message || 'An error occurred'}
          {msg.code && <div className="text-xs text-red-500 mt-1">Code: {msg.code}</div>}
        </div>
      </div>
    );
  }

  if (msg.type === 'tool_use') {
    return (
      <div className="message-enter flex gap-3">
        <div className="w-7 h-7 rounded-lg bg-purple-600/20 flex items-center justify-center flex-shrink-0">
          <Zap size={14} className="text-purple-400" />
        </div>
        <div className="bg-purple-900/10 border border-purple-800/30 rounded-xl px-4 py-2 text-xs text-purple-300">
          🔧 Using tool: <span className="font-mono">{msg.tool}</span>
        </div>
      </div>
    );
  }

  // User message (simple text, no tool_call prefix)
  const isUser = !msg.content?.startsWith('{') && msg.content?.length < 200 && !msg.content?.includes('\n');

  return (
    <div className={`message-enter flex gap-3 ${isUser ? 'justify-end' : ''}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Zap size={14} className="text-white" />
        </div>
      )}
      <div className={`rounded-xl px-4 py-3 text-sm leading-relaxed max-w-[85%] ${
        isUser ? 'bg-blue-600/20 border border-blue-700/30' : 'bg-gray-800/50'
      }`}>
        <div className="whitespace-pre-wrap">{msg.content}</div>
      </div>
      {isUser && (
        <div className="w-7 h-7 rounded-lg bg-gray-700 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-bold">
          U
        </div>
      )}
    </div>
  );
}
