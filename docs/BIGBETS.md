# Big Bets – Nachrichten-Wächter mit Push

Ziel: Weltweit Nachrichten überwachen und **nur** bei seltenen, marktbewegenden Ereignissen mit klarer Folge für einen Markt
(„Big Bets“) eine Push-Nachricht als Einzeiler aufs Handy schicken. Beispiele: Militärschlag im Nahen Osten → Öl ↑;
US-Regierung lockert Krypto-Regulierung → Bitcoin ↑; überraschende Zinssenkung → Gold ↑ / Währung ↓; OPEC-Kürzung → Öl ↑;
Exportverbot für Chips → betroffene Halbleiter ↓. Weltweit, nicht nur USA.

## Ablauf (ein Lauf alle ~5 Minuten, GitHub Actions)
1. **Sammeln** (`bot/feeds.py`): RSS/Atom und GDELT, nur Meldungen der letzten 6 h, die noch nicht gesehen wurden.
2. **Vorsortieren** (`bot/triage.py`): `claude-haiku-5-5`, effort `low`, strukturierte Ausgabe. Bewertet alle neuen Schlagzeilen in einem Batch
   (0–10 „Marktrelevanz für Big Bet“). Nur ≥ 7 gehen weiter, max. 5 pro Lauf.
3. **Bewerten** (`bot/assess.py`): `claude-opus-5-5`, effort `high`, strukturierte Ausgabe, Server-Fallbacks (`fallbacks: "default"`).
   Bekommt die Meldung, verwandte Schlagzeilen des Laufs und die Alarme der letzten 72 h (Duplikat-Erkennung: gleiches Ereignis → kein neuer Alarm,
   außer echte Eskalation/Wende). Ergebnis siehe Schema.
4. **Kurscheck** (`bot/prices.py`): Für jeden betroffenen Wert die Veränderung seit Vortagesschluss und über 5 Tage (Yahoo Chart-API),
   damit sichtbar ist, ob der Zug schon abgefahren ist.
5. **Push** (`bot/notify.py`): nur wenn `is_big_bet` und `confidence >= ALERT_MIN_CONFIDENCE` (Default 75). Über ntfy.sh.
6. **Speichern** (`bot/state.py`): Zustand und Alarme auf dem Branch `data` (`state.json`, `alerts.json`).

Kostenbremse: max. `MAX_ASSESS_PER_DAY` (Default 40) Opus-Aufrufe pro UTC-Tag, im Zustand gezählt. Fehlt `ANTHROPIC_API_KEY`, bricht der Lauf ab, ohne zu pushen.

## Konfiguration (GitHub Secrets / Variablen)
| Name | Art | Bedeutung |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | API-Key von console.anthropic.com |
| `NTFY_TOPIC` | Secret | geheimer, zufälliger Kanalname (z. B. `bigbets-7f3k9q2xw1`) – wer ihn kennt, bekommt die Pushes |
| `ALERT_MIN_CONFIDENCE` | Variable (optional) | Schwelle 0–100, Default 75 |
| `MAX_ASSESS_PER_DAY` | Variable (optional) | Default 40 |
| `NTFY_SERVER` | Variable (optional) | Default `https://ntfy.sh` |

## Datenformat `alerts.json` (Branch `data`, öffentlich lesbar über raw.githubusercontent.com)
```json
{
  "updated_at": 1760000000,
  "alerts": [
    {
      "id": "a1b2c3d4",                     // stabil, kurz (Hash)
      "created_at": 1760000000,
      "event_key": "us-iran-strike-2026-10", // für Duplikat-Erkennung
      "headline": "USA greifen iranische Ölanlagen an",          // deutsch, kurz
      "one_liner": "🛢️ LONG Öl (Brent) · USA greifen Iran an · hoch · Tage",  // = Push-Text
      "assets": [
        {"name": "Brent-Öl", "ticker": "BZ=F", "direction": "long", "conviction": 9,
         "change_1d_pct": 4.2, "change_5d_pct": 6.1}           // Kursänderungen können null sein
      ],
      "confidence": 82,                      // 0..100
      "horizon": "Tage",                     // "Stunden" | "Tage" | "Wochen" | "Monate"
      "rationale": "2–4 Sätze auf Deutsch: Wirkungskette, warum wahrscheinlich.",
      "priced_in": "teilweise",              // "nein" | "teilweise" | "weitgehend"
      "risks": "1–2 Sätze: Was die These kaputt macht.",
      "second_order": ["Tanker-Reedereien ↑", "Airlines ↓"],  // optional, kann leer sein
      "sources": [{"title": "…", "url": "https://…", "source": "Reuters", "published": 1760000000}]
    }
  ]
}
```
Neueste zuerst, max. 200 Einträge.

## Push-Format (ntfy)
- Titel: `headline`
- Nachricht: `one_liner` + optional Zeile `Bereits: Brent +4,2 % heute` wenn Kursdaten vorhanden
- `Click`: Link zur App-Detailansicht `https://marcusgrundmann90-hub.github.io/Trading-/#<id>`
- `Priority`: 5 (urgent) bei confidence ≥ 90, sonst 4; `Tags` passend (z. B. `chart_with_upwards_trend` / `chart_with_downwards_trend`)

## Mini-App (`web/`, GitHub Pages)
Eine Seite: Liste der Alarme als Einzeiler (neueste oben), Antippen klappt Begründung, Risiken, Folgen zweiter Ordnung, Kursänderung
und Quellen auf. Daten: `https://raw.githubusercontent.com/marcusgrundmann90-hub/Trading-/data/alerts.json`.
Kopf: „Letzter Check vor X Min“ (aus `updated_at`). Unten: Einrichtungs-Hinweis für ntfy und der Disclaimer. PWA (installierbar, offline letzte Liste).
