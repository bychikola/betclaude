"""
Report Generator — creates match analysis reports in multiple formats.

Formats:
- markdown: for chat display
- json: for API consumption
- pdf: for download/print (via WeasyPrint)
"""

import importlib
import json
import os
import time
from datetime import datetime, timezone
from typing import Any

from loguru import logger

from ..predictor.models import MatchPredictor


class ReportGenerator:
    """Generates formatted reports for matches."""

    def __init__(self):
        self.predictor = MatchPredictor()

    async def generate(
        self,
        match_id: str,
        format: str = "markdown",
        sections: list[str] | None = None,
    ) -> dict:
        """
        Generate a report for a match.

        Args:
            match_id: Match identifier
            format: "markdown", "json", or "pdf"
            sections: Which sections to include
        """
        sections = sections or ["summary", "stats", "h2h", "prediction"]

        # Gather all data
        analysis = await self.predictor.analyze(match_id)

        if format == "json":
            return self._generate_json(match_id, analysis, sections)
        elif format == "pdf":
            return await self._generate_pdf(match_id, analysis, sections)
        else:
            return self._generate_markdown(match_id, analysis, sections)

    # ============================================================
    # Markdown report
    # ============================================================

    def _generate_markdown(
        self, match_id: str, analysis: dict, sections: list[str]
    ) -> dict:
        """Generate a Markdown report."""
        info = analysis.get("match_info", {})
        lines = []

        # Header
        lines.append(f"# 📊 Match Analysis: {info.get('home_team')} vs {info.get('away_team')}")
        lines.append("")
        lines.append(f"**League**: {info.get('league')} | **Sport**: {info.get('sport')}")
        lines.append(f"**Status**: {info.get('status')} | **Start**: {info.get('start_time')}")
        lines.append("")
        lines.append("---")
        lines.append("")

        # Prediction
        if "prediction" in sections and "prediction" in analysis:
            pred = analysis["prediction"]
            lines.append("## 🔮 Prediction")
            lines.append("")
            lines.append(f"| Outcome | Probability |")
            lines.append(f"|---------|------------|")
            for outcome, prob in pred.get("probabilities", {}).items():
                emoji = {"home_win": "🏠", "draw": "🤝", "away_win": "✈️"}.get(outcome, "")
                label = {"home_win": "Home Win", "draw": "Draw", "away_win": "Away Win"}.get(outcome, outcome)
                lines.append(f"| {emoji} {label} | {prob*100:.1f}% |")
            lines.append("")
            lines.append(f"**Expected score**: {pred.get('home_score')} — {pred.get('away_score')}")
            lines.append(f"**Model**: {pred.get('model')} | **Confidence**: {pred.get('confidence', 0)*100:.1f}%")
            lines.append("")

        # Team form
        if "stats" in sections:
            lines.append("---")
            lines.append("")

            home = analysis.get("home_team", {})
            away = analysis.get("away_team", {})

            lines.append(f"## 📈 {home.get('team_name', 'Home')} — Recent Form")
            hf = home.get("recent_form", {})
            lines.append(f"`{hf.get('wins',0)}W {hf.get('draws',0)}D {hf.get('losses',0)}L` "
                        f"| GF:{hf.get('goals_for',0)} GA:{hf.get('goals_against',0)} "
                        f"| Trend: **{hf.get('trend','stable')}**")
            lines.append("")

            lines.append(f"## 📈 {away.get('team_name', 'Away')} — Recent Form")
            af = away.get("recent_form", {})
            lines.append(f"`{af.get('wins',0)}W {af.get('draws',0)}D {af.get('losses',0)}L` "
                        f"| GF:{af.get('goals_for',0)} GA:{af.get('goals_against',0)} "
                        f"| Trend: **{af.get('trend','stable')}**")
            lines.append("")

            # Season stats
            hs = home.get("season_stats", {})
            if hs:
                lines.append("### Season Stats")
                lines.append("")
                lines.append(f"| Metric | {home.get('team_name')} | {away.get('team_name')} |")
                lines.append(f"|--------|-------|-------|")
                metrics = [
                    ("Possession %", "avg_possession"),
                    ("Shots/game", "avg_shots"),
                    ("Shots on target/game", "avg_shots_on_target"),
                    ("Expected Goals (xG)", "avg_xg"),
                ]
                for label, key in metrics:
                    hv = hs.get(key, "-")
                    av = away.get("season_stats", {}).get(key, "-")
                    lines.append(f"| {label} | {hv} | {av} |")
                lines.append("")

        # H2H
        if "h2h" in sections and "head_to_head" in analysis:
            h2h = analysis["head_to_head"]
            summary = h2h.get("summary", {})
            lines.append("---")
            lines.append("")
            lines.append(f"## 🤜🤛 Head-to-Head History ({summary.get('total_matches', 0)} meetings)")
            lines.append("")
            lines.append(f"Home Wins: **{summary.get('home_wins', 0)}** | "
                        f"Draws: **{summary.get('draws', 0)}** | "
                        f"Away Wins: **{summary.get('away_wins', 0)}**")
            lines.append("")

            recent = summary.get("recent_matches", [])[:5]
            if recent:
                lines.append("| Date | Match | Score |")
                lines.append("|------|-------|-------|")
                for m in recent:
                    lines.append(
                        f"| {m.get('date','')[:10]} | "
                        f"{m.get('home_team','')} vs {m.get('away_team','')} | "
                        f"{m.get('home_score','')}-{m.get('away_score','')} |"
                    )
                lines.append("")

        # Key factors
        if "summary" in sections and "key_factors" in analysis:
            lines.append("---")
            lines.append("")
            lines.append("## 🔑 Key Factors")
            lines.append("")
            for factor in analysis.get("key_factors", []):
                lines.append(f"- {factor}")
            lines.append("")

        # Footer
        lines.append("---")
        lines.append("")
        lines.append(f"*Report generated by BetClaude Analytics at "
                    f"{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}*")

        content = "\n".join(lines)

        return {
            "report_id": f"rpt_{match_id}_{int(time.time())}",
            "format": "markdown",
            "content": content,
            "generated_at": int(time.time() * 1000),
        }

    # ============================================================
    # JSON report
    # ============================================================

    def _generate_json(
        self, match_id: str, analysis: dict, sections: list[str]
    ) -> dict:
        """Generate a JSON report."""
        report = {
            "report_id": f"rpt_{match_id}_{int(time.time())}",
            "format": "json",
            "generated_at": int(time.time() * 1000),
            "match_id": match_id,
        }

        section_map = {
            "summary": "match_info",
            "stats": None,  # home_team + away_team
            "h2h": "head_to_head",
            "prediction": "prediction",
            "odds": "odds",
        }

        for section in sections:
            key = section_map.get(section)
            if key and key in analysis:
                report[section] = analysis[key]
            elif section == "stats":
                report["home_team_analysis"] = analysis.get("home_team")
                report["away_team_analysis"] = analysis.get("away_team")

        report["content"] = json.dumps(report, indent=2, default=str)
        return report

    # ============================================================
    # PDF report
    # ============================================================

    async def _generate_pdf(
        self, match_id: str, analysis: dict, sections: list[str]
    ) -> dict:
        """Generate a PDF report using WeasyPrint."""
        # Generate HTML from markdown
        md_report = self._generate_markdown(match_id, analysis, sections)
        markdown_content = md_report["content"]

        # Convert Markdown to HTML
        html = self._markdown_to_html(markdown_content)

        # Full HTML document
        full_html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {{ font-family: 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; color: #1a1a1a; }}
  h1 {{ color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }}
  h2 {{ color: #374151; margin-top: 24px; }}
  table {{ border-collapse: collapse; width: 100%; margin: 12px 0; }}
  th, td {{ border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; }}
  th {{ background: #f3f4f6; font-weight: 600; }}
  code {{ background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }}
  hr {{ border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }}
</style>
</head>
<body>
{html}
</body>
</html>"""

        # In production: WeasyPrint
        # pdf_bytes = HTML(string=full_html).write_pdf()

        return {
            "report_id": f"rpt_{match_id}_{int(time.time())}",
            "format": "pdf",
            "content": full_html,  # In production: base64 PDF
            "content_type": "text/html",  # Would be "application/pdf"
            "generated_at": int(time.time() * 1000),
        }

    def _markdown_to_html(self, md: str) -> str:
        """Simple markdown to HTML converter.

        In production, use a proper library like 'markdown' or 'mistune'.
        """
        # Try using markdown library if available
        try:
            markdown_lib = importlib.import_module("markdown")
            return markdown_lib.markdown(md, extensions=["tables", "fenced_code"])
        except ImportError:
            pass

        # Fallback: basic conversion
        lines = md.split("\n")
        html_lines = []
        in_table = False
        in_code = False

        for line in lines:
            # Code blocks
            if line.startswith("```"):
                in_code = not in_code
                html_lines.append("</pre>" if not in_code else "<pre>")
                continue

            if in_code:
                html_lines.append(line)
                continue

            # Tables
            if "|" in line and line.strip().startswith("|"):
                if not in_table:
                    in_table = True
                    html_lines.append("<table>")
                cells = [c.strip() for c in line.split("|")[1:-1]]
                if all(c.replace("-", "").replace(":", "") == "" for c in cells):
                    continue  # Skip separator row
                tag = "th" if in_table and len(html_lines) == html_lines.index("<table>") + 1 else "td"
                html_lines.append("<tr>" + "".join(f"<{tag}>{c}</{tag}>" for c in cells) + "</tr>")
                continue
            elif in_table:
                in_table = False
                html_lines.append("</table>")

            # Headers
            if line.startswith("# "):
                html_lines.append(f"<h1>{line[2:]}</h1>")
            elif line.startswith("## "):
                html_lines.append(f"<h2>{line[3:]}</h2>")
            elif line.startswith("### "):
                html_lines.append(f"<h3>{line[4:]}</h3>")
            # Bold
            elif "**" in line:
                import re
                line = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", line)
                html_lines.append(f"<p>{line}</p>" if line else "<br/>")
            # HR
            elif line.strip() == "---":
                html_lines.append("<hr/>")
            # List items
            elif line.strip().startswith("- "):
                html_lines.append(f"<li>{line.strip()[2:]}</li>")
            # Regular paragraph
            elif line.strip():
                html_lines.append(f"<p>{line}</p>")
            else:
                html_lines.append("<br/>")

        if in_table:
            html_lines.append("</table>")

        return "\n".join(html_lines)
