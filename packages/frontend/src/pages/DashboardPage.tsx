import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { matches as matchesApi, sports as sportsApi } from '../lib/api';
import { MessageCircle, LogOut, Zap, TrendingUp, Activity, BarChart3 } from 'lucide-react';

export function DashboardPage() {
  const { user, logout } = useAuth();
  const [liveMatches, setLiveMatches] = useState<any[]>([]);
  const [sportsList, setSportsList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      matchesApi.list({ status: 'live' }).catch(() => ({ matches: [] })),
      matchesApi.list({ status: 'scheduled' }).catch(() => ({ matches: [] })),
      sportsApi.list().catch(() => ({ sports: [] })),
    ]).then(([live, scheduled, sportsData]) => {
      setLiveMatches((live as any).matches || []);
      setSportsList((sportsData as any).sports || []);
      setLoading(false);
    });
  }, []);

  const stats = [
    { label: 'Live Matches', value: liveMatches.length, icon: Activity, color: 'text-green-400' },
    { label: 'Sports', value: sportsList.length, icon: BarChart3, color: 'text-blue-400' },
    { label: 'Subscription', value: user?.subscription || 'free', icon: Zap, color: 'text-yellow-400' },
    { label: 'Analyses Today', value: '—', icon: TrendingUp, color: 'text-purple-400' },
  ];

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Navbar */}
      <nav className="border-b border-gray-800 bg-gray-900/50 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/" className="text-xl font-bold">
            <span className="text-blue-500">Bet</span><span className="text-white">Claude</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/chat" className="btn-primary text-sm flex items-center gap-2">
              <MessageCircle size={16} /> New Analysis
            </Link>
            <Link to="/sessions" className="text-sm text-gray-400 hover:text-white">History</Link>
            <span className="text-sm text-gray-500">{user?.username}</span>
            <button onClick={logout} className="text-gray-500 hover:text-red-400 transition-colors">
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              {stats.map(s => (
                <div key={s.label} className="card flex items-center gap-4">
                  <s.icon size={24} className={s.color} />
                  <div>
                    <div className="text-2xl font-bold">{s.value}</div>
                    <div className="text-xs text-gray-500">{s.label}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Live Now */}
            <section className="mb-8">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Activity size={20} className="text-green-400" />
                Live Now
              </h2>
              {liveMatches.length === 0 ? (
                <div className="card text-center text-gray-500 py-8">
                  No live matches right now. Check back later!
                </div>
              ) : (
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {liveMatches.slice(0, 6).map((m: any) => (
                    <MatchCard key={m.id} match={m} />
                  ))}
                </div>
              )}
            </section>

            {/* Quick Start */}
            <section>
              <h2 className="text-lg font-semibold mb-4">Quick Analysis</h2>
              <div className="card text-center py-12">
                <MessageCircle size={40} className="mx-auto mb-4 text-blue-400" />
                <h3 className="text-xl font-semibold mb-2">Start a new analysis</h3>
                <p className="text-gray-400 mb-6 max-w-md mx-auto">
                  Ask BetClaude about any match, team, or league.
                  Get data-driven predictions, live stats, and deep tactical analysis.
                </p>
                <Link to="/chat" className="btn-primary inline-flex items-center gap-2">
                  <MessageCircle size={18} /> Start Chat
                </Link>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function MatchCard({ match: m }: { match: any }) {
  return (
    <Link to={`/chat?match=${m.id}`} className="card hover:border-gray-700 transition-all duration-200 group">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-gray-500">{m.league_name}</span>
        <span className="flex items-center gap-1.5 text-xs text-green-400">
          <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
          {m.minute}'</span>
      </div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium">{m.home_team}</div>
        <div className="text-lg font-bold mx-3">{m.home_score} — {m.away_score}</div>
        <div className="text-sm font-medium text-right">{m.away_team}</div>
      </div>
      <div className="text-xs text-gray-600 group-hover:text-blue-400 transition-colors">
        Click to analyze →
      </div>
    </Link>
  );
}
