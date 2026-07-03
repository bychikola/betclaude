-- ============================================================
-- Demo seed data for BetClaude
-- Provides sample leagues, teams, and matches for development
-- ============================================================

-- Leagues (football)
INSERT INTO leagues (id, sport_id, name, country, tier) VALUES
  ('a0000000-0000-0000-0000-000000000001', (SELECT id FROM sports WHERE slug='football'), 'Premier League', 'England', 1),
  ('a0000000-0000-0000-0000-000000000002', (SELECT id FROM sports WHERE slug='football'), 'La Liga', 'Spain', 1),
  ('a0000000-0000-0000-0000-000000000003', (SELECT id FROM sports WHERE slug='football'), 'Bundesliga', 'Germany', 1),
  ('a0000000-0000-0000-0000-000000000004', (SELECT id FROM sports WHERE slug='football'), 'Serie A', 'Italy', 1),
  ('a0000000-0000-0000-0000-000000000005', (SELECT id FROM sports WHERE slug='football'), 'Ligue 1', 'France', 1)
ON CONFLICT (id) DO NOTHING;

-- Teams (Premier League)
INSERT INTO teams (id, league_id, name, short_name) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Manchester City', 'MCI'),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Arsenal', 'ARS'),
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Liverpool', 'LIV'),
  ('b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'Manchester United', 'MUN'),
  ('b0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'Chelsea', 'CHE'),
  ('b0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', 'Tottenham Hotspur', 'TOT'),
  ('b0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', 'Newcastle United', 'NEW'),
  ('b0000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000001', 'Aston Villa', 'AVL')
ON CONFLICT (id) DO NOTHING;

-- Teams (La Liga)
INSERT INTO teams (id, league_id, name, short_name) VALUES
  ('b0000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000002', 'Real Madrid', 'RMA'),
  ('b0000000-0000-0000-0000-000000000102', 'a0000000-0000-0000-0000-000000000002', 'Barcelona', 'BAR'),
  ('b0000000-0000-0000-0000-000000000103', 'a0000000-0000-0000-0000-000000000002', 'Atletico Madrid', 'ATM'),
  ('b0000000-0000-0000-0000-000000000104', 'a0000000-0000-0000-0000-000000000002', 'Sevilla', 'SEV')
ON CONFLICT (id) DO NOTHING;

-- Demo matches
INSERT INTO matches (id, sport_id, league_id, home_team_id, away_team_id, start_time, status, home_score, away_score, minute, venue) VALUES
  -- Live matches
  ('c0000000-0000-0000-0000-000000000001', (SELECT id FROM sports WHERE slug='football'), 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', NOW() - INTERVAL '65 minutes', 'live', 2, 1, 65, 'Etihad Stadium'),
  ('c0000000-0000-0000-0000-000000000002', (SELECT id FROM sports WHERE slug='football'), 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000005', NOW() - INTERVAL '70 minutes', 'live', 1, 1, 70, 'Anfield'),
  ('c0000000-0000-0000-0000-000000000003', (SELECT id FROM sports WHERE slug='football'), 'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000101', 'b0000000-0000-0000-0000-000000000102', NOW() - INTERVAL '55 minutes', 'live', 1, 1, 55, 'Santiago Bernabeu'),
  -- Scheduled matches
  ('c0000000-0000-0000-0000-000000000004', (SELECT id FROM sports WHERE slug='football'), 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000006', NOW() + INTERVAL '2 hours', 'scheduled', NULL, NULL, NULL, 'Old Trafford'),
  ('c0000000-0000-0000-0000-000000000005', (SELECT id FROM sports WHERE slug='football'), 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000008', 'b0000000-0000-0000-0000-000000000007', NOW() + INTERVAL '4 hours', 'scheduled', NULL, NULL, NULL, 'Villa Park'),
  -- Finished matches
  ('c0000000-0000-0000-0000-000000000006', (SELECT id FROM sports WHERE slug='football'), 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003', NOW() - INTERVAL '2 days', 'finished', 1, 3, NULL, 'Emirates Stadium'),
  ('c0000000-0000-0000-0000-000000000007', (SELECT id FROM sports WHERE slug='football'), 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000001', NOW() - INTERVAL '3 days', 'finished', 0, 4, NULL, 'Stamford Bridge'),
  ('c0000000-0000-0000-0000-000000000008', (SELECT id FROM sports WHERE slug='football'), 'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000102', 'b0000000-0000-0000-0000-000000000103', NOW() - INTERVAL '1 day', 'finished', 2, 0, NULL, 'Camp Nou')
ON CONFLICT (id) DO NOTHING;

-- Match events for live match 1 (City vs Arsenal)
INSERT INTO match_events (match_id, type, minute, team_id, player_name, detail) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'goal', 23, 'b0000000-0000-0000-0000-000000000001', 'Erling Haaland', 'Left foot shot from center of box'),
  ('c0000000-0000-0000-0000-000000000001', 'goal', 41, 'b0000000-0000-0000-0000-000000000002', 'Bukayo Saka', 'Right foot shot from right side of box'),
  ('c0000000-0000-0000-0000-000000000001', 'yellow_card', 54, 'b0000000-0000-0000-0000-000000000001', 'Rodri', 'Tactical foul'),
  ('c0000000-0000-0000-0000-000000000001', 'goal', 58, 'b0000000-0000-0000-0000-000000000001', 'Kevin De Bruyne', 'Free kick from 25 yards'),
  ('c0000000-0000-0000-0000-000000000001', 'substitution', 62, 'b0000000-0000-0000-0000-000000000002', 'Gabriel Martinelli', 'Replaces Trossard');

-- Match stats
INSERT INTO match_stats (match_id, team_id, possession, shots, shots_on_target, corners, fouls, expected_goals, pass_accuracy) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 58.5, 14, 7, 6, 10, 1.8, 89.2),
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 41.5, 8, 3, 3, 12, 0.9, 82.1);

-- Odds for live match
INSERT INTO live_odds (match_id, provider, market, home_odds, draw_odds, away_odds) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'pinnacle', '1X2', 1.85, 3.60, 4.20),
  ('c0000000-0000-0000-0000-000000000001', 'bet365', '1X2', 1.90, 3.50, 4.00);
