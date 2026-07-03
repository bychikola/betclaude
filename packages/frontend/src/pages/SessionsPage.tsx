import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { chat } from '../lib/api';
import { MessageCircle, Home, LogOut, Trash2, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';

export function SessionsPage() {
  const { user, logout } = useAuth();
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    chat.sessions().then((data: any) => {
      setSessions(data.sessions || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await chat.deleteSession(id);
      setSessions(prev => prev.filter(s => s.id !== id));
      toast.success('Session deleted');
    } catch {
      toast.error('Failed to delete session');
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex">
      {/* Sidebar */}
      <aside className="w-64 border-r border-gray-800 bg-gray-900/50 flex-col hidden lg:flex">
        <div className="p-4 border-b border-gray-800">
          <Link to="/" className="text-lg font-bold">
            <span className="text-blue-500">Bet</span><span className="text-white">Claude</span>
          </Link>
        </div>
        <div className="flex-1 p-3">
          <Link to="/" className="flex items-center gap-2 text-sm text-gray-400 hover:text-white py-2 px-2 rounded-lg hover:bg-gray-800">
            <Home size={16} /> Dashboard
          </Link>
          <Link to="/chat" className="flex items-center gap-2 text-sm text-gray-400 hover:text-white py-2 px-2 rounded-lg hover:bg-gray-800">
            <MessageCircle size={16} /> New Chat
          </Link>
        </div>
        <div className="p-3 border-t border-gray-800">
          <button onClick={logout} className="flex items-center gap-2 text-sm text-gray-400 hover:text-red-400 py-2 px-2 w-full">
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1">
        <header className="h-14 border-b border-gray-800 flex items-center px-4">
          <h1 className="text-lg font-semibold">Chat History</h1>
        </header>

        <div className="max-w-4xl mx-auto p-4">
          {loading ? (
            <div className="flex justify-center py-20">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-20">
              <MessageCircle size={40} className="mx-auto mb-4 text-gray-600" />
              <p className="text-gray-500 mb-4">No chat sessions yet</p>
              <Link to="/chat" className="btn-primary inline-flex items-center gap-2">
                <MessageCircle size={16} /> Start First Chat
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map(s => (
                <div key={s.id} className="card flex items-center justify-between group hover:border-gray-700 transition-all">
                  <Link to={`/chat/${s.id}`} className="flex-1 flex items-center gap-4 min-w-0">
                    <MessageCircle size={18} className="text-gray-600 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{s.title}</div>
                      <div className="text-xs text-gray-500">
                        {s.message_count || 0} messages · {new Date(s.updated_at).toLocaleDateString()}
                        {s.sport && <span className="ml-2">· {s.sport}</span>}
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-gray-600 ml-auto flex-shrink-0" />
                  </Link>
                  <button
                    onClick={() => handleDelete(s.id)}
                    className="ml-4 p-2 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
